# AGENTS.md

Windlass is a policy engine that decides, for each agent-authored pull request, whether to auto-merge, escalate to a human, or block. The design brief is `docs/brief.md`; read it before changing engine behaviour.

## Repo Shape

- `src/` is the engine library (`@pluscosmic/windlass`). It has no GitHub or LLM dependencies, so it can later back a GitHub Action, App or CLI.
  - `policy/` parses `.windlass/policy.yaml` into the normalized model in `policy/types.ts` (also the type surface for the future flowchart editor).
  - `facts/` turns a `PullRequestInput` (base/head SHA, PR body, unified diff, CI checks) into `Facts`. `facts/diff.ts` is the unified diff parser.
  - `gates/` holds deterministic checks. Each gate is a `defineGate({...})` with a zod `args` schema and a `defaultOnFail`; register built-ins in `gates/registry.ts`.
  - `evaluators/types.ts` defines the LLM evaluator contract (`EvaluatorRunner`, `VerdictSchema`). No runner is implemented yet.
  - `engine.ts` (`decide`) walks the policy and returns a `DecisionRecord` (`decision.ts`).
  - `harness.ts` (`@pluscosmic/windlass/harness`) runs fixtures from disk.
- `action/` is the GitHub Action (`action.yml` at the repo root). `action/src/run.ts` holds the logic against the `GitHubPort` interface (`port.ts`), `octokit.ts` implements it, `comment.ts` renders decisions, and `main.ts` is the entry point. `action/dist/index.mjs` is the committed esbuild bundle: after changing `src/` or `action/src/`, run `bun run build:action` and commit the result.
- `test/fixtures/<case>/` holds `case.yaml` (PR body, CI, expected decision) and `diff.patch`; `test/fixtures/policy.yaml` is their default policy. Each case runs as a test in `test/fixtures.test.ts`.
- `examples/` holds the phase 1 policy and workflow to copy into a pilot repo.

## Engine Rules

These come from the brief and are what the tests protect; don't loosen them without updating the brief.

- Fail closed. Anything unexpected (invalid policy, unparseable diff, missing or malformed `windlass` block, gate error, evaluator error/timeout/malformed output/low confidence) escalates. `decide` never throws for bad input.
- Gate failures contribute the gate's `on_fail` (defaults: `no_new_skips` blocks; `paths_only` and `ci_green` escalate). Outcomes combine by severity: `block` > `pending` > `escalate` > `merge`.
- `pending` means "decide later" (CI still running); it isn't a terminal outcome.
- Evaluators run only while the PR is still on the merge path, and can only push it to escalate.
- Evaluators get the diff, structured intent and gate-computed facts. Never pass them the PR body, commit messages or code review text.
- Changes under `.windlass/` always escalate. Policies are loaded from the base branch, never the PR head.
- Policies naming an unknown gate are invalid; don't skip unknown gates.
- The Action only runs in shadow mode: it comments and labels, never merges. It reads PR content through the API and never checks out or runs PR code.
- PR comments render attacker-controlled text (paths, code, reasons); keep everything dynamic going through `text()`/`code()` in `comment.ts`.

## Commands

- Install with `bun install`; the repo pins `bun@1.3.13`. Code targets Node 22+ (GitHub Actions runtime).
- `bun run check` runs typecheck, lint, test, build, build:action and format:check.
- `bun run test` is Vitest over `src/`, `test/` and `action/src/`.
- Add a behaviour case as a fixture: make the diff with real `git diff` rather than writing hunks by hand.
