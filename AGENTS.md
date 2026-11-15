# AGENTS.md

Windlass is a policy engine that decides, for each agent-authored pull request, whether to auto-merge, escalate to a human, or block. The design brief is `docs/brief.md`; read it before changing engine behaviour.

## Repo Shape

- `src/` is the engine library (`@pluscosmic/windlass`). It has no GitHub or LLM dependencies, so it can later back a GitHub Action, App or CLI.
  - `policy/` parses `.windlass/policy.yaml` into the normalized model in `policy/types.ts` (also the type surface for the future flowchart editor).
  - `facts/` turns a `PullRequestInput` (base/head SHA, PR body, unified diff, CI checks) into `Facts`. `facts/diff.ts` is the unified diff parser.
  - `gates/` holds deterministic checks. Each gate is a `defineGate({...})` with a zod `args` schema and a `defaultOnFail`; register built-ins in `gates/registry.ts`.
  - `evaluators/` is the LLM evaluator contract and everything about a question that isn't a model call: `types.ts` (`EvaluatorRunner`, `VerdictSchema`), `question.ts` (the `{{flag}}`/`{{issue}}` placeholders), `presets.ts` (built-in questions) and `prompt.ts` (the prompt and the verdict's JSON Schema). The engine never calls a model; a runner does.
  - `engine.ts` (`decide`) walks the policy and returns a `DecisionRecord` (`decision.ts`).
  - `harness.ts` (`@pluscosmic/windlass/harness`) runs fixtures from disk.
  - `graph.ts` draws a policy as a flowchart (`policyToGraph`) and lays a decision over it (`traceDecision`). It is a view of the walk `decide` does, not a second policy format.
  - `policy/edit.ts` (`applyEdit`) makes the editor's changes to the YAML source, keeping its comments.
- `github/` is the GitHub adapter the Action and the App share: the `GitHubPort` interface (`port.ts`), its Octokit implementation (`octokit.ts`), `run.ts` (snapshot a PR, decide it, report it) and `comment.ts` (render decisions).
- `action/` is the GitHub Action (`action.yml` at the repo root); `action/src/main.ts` is its entry point. `action/dist/index.mjs` is the committed esbuild bundle: after changing `src/`, `github/` or `action/src/`, run `bun run build:action` and commit the result.
- `app/` is the GitHub App: a Hono server (`http.ts`) that takes webhooks (`webhooks.ts`), judges PRs and replays them under draft policies (`service.ts`), and keeps repos, PR snapshots and decisions in SQLite (`store.ts`, `node:sqlite`). `config.ts` picks `app` mode (all GitHub settings present) or `dev` mode (`WINDLASS_DEV=1`: loopback only, no sign-in, never writes to GitHub). `evaluations.ts` queues evaluator questions and keeps verdicts. The same bundle run as `server.mjs runner` is the evaluator runner (`runner.ts`): a separate process that pulls questions from the App over HTTP, puts them to a model through a `ModelBackend` (`claude-backend.ts`, the Claude Agent SDK) and posts the answers back. It bundles to `app/dist/server.mjs`, which is not committed.
- `web/` is the policy editor the App serves: React, React Flow (`Canvas.tsx`) and `@pluscosmic/ui`. Its words live in `web/src/copy/` (the `ui/no-jsx-copy` lint rule). It imports `src/graph.ts` and `src/policy/edit.ts` directly, never `src/index.ts`, which pulls in Node built-ins.
- `test/fixtures/<case>/` holds `case.yaml` (PR body, CI, expected decision) and `diff.patch`; `test/fixtures/policy.yaml` is their default policy. Each case runs as a test in `test/fixtures.test.ts`.
- `examples/` holds the phase 1 policy and workflow to copy into a pilot repo.
- A fixture can stub what its evaluators answer (`verdicts:` in `case.yaml`), which is also what dev mode shows for them.

## Engine Rules

These come from the brief and are what the tests protect; don't loosen them without updating the brief.

- Fail closed. Anything unexpected (invalid policy, unparseable diff, missing or malformed `windlass` block, gate error, evaluator error/timeout/malformed output/low confidence) escalates. `decide` never throws for bad input.
- Gate failures contribute the gate's `on_fail` (defaults: `no_new_skips` blocks; `paths_only` and `ci_green` escalate). Outcomes combine by severity: `block` > `pending` > `escalate` > `merge`.
- `pending` means "decide later" (CI still running); it isn't a terminal outcome.
- Evaluators run only while the PR is still on the merge path, and can only push it to escalate.
- Evaluators get the diff, structured intent and gate-computed facts. Never pass them the PR body, commit messages or code review text.
- An evaluator's question is written in the policy (or is the built-in one for its name), so it is read from the base branch like the rest of the policy. The only PR-supplied text that reaches a question is the declared `flag` (a plain key, enforced by `parseIntent`) and `issue` (a number).
- A verdict that cites a file the diff doesn't change, or fails without evidence, is an evaluator error. A malformed answer is never stored.
- Windlass never holds a model credential and a runner never holds a GitHub one. The runner gets the prompt and nothing that names the repo, runs the model with every tool off, and refuses to start with the App's secrets in its environment. Runner tokens are scoped to an installation (or all of them, for a single-owner deployment).
- Replaying under a draft never asks a model: it reads stored verdicts, and anything else shows as `not_run`. Only judging a live PR, or the editor's run button, queues a question.
- Changes under `.windlass/` always escalate. Policies are loaded from the base branch, never the PR head.
- Policies naming an unknown gate are invalid; don't skip unknown gates.
- The Action and the App only run in shadow mode: they comment, label and (the App) report a check run, and never merge. They read PR content through the API and never check out or run PR code.
- The App's check run is never a failing one, and its text never quotes reasons or evidence; those go in the comment, escaped.
- The editor never changes a policy directly. It replays stored PRs under a draft, and saves by opening a PR that touches `.windlass/`, which Windlass itself escalates.
- The App refuses to start half-configured, and every `/api` route needs a signed-in login from `WINDLASS_ADMINS`; only `WINDLASS_DEV=1` skips the sign-in, and then it only listens on loopback.
- PR comments render attacker-controlled text (paths, code, reasons); keep everything dynamic going through `text()`/`code()` in `comment.ts`.

## Commands

- Install with `bun install`; the repo pins `bun@1.3.13`. Code targets Node 22+ (GitHub Actions runtime).
- `bun run check` runs typecheck, lint, test, build, build:action, build:app, build:web and format:check.
- `bun run test` is Vitest over `src/`, `test/`, `github/`, `app/src/` and `web/src/`.
- `bun run build:web && bun run dev:server` runs the App locally in dev mode with the fixtures as sample PRs; `docs/deploy.md` covers importing a real repo's PRs and deploying.
- Add a behaviour case as a fixture: make the diff with real `git diff` rather than writing hunks by hand.
