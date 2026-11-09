# Windlass — Brief

Nov 9, 2026 · @Harry

## Overview

Windlass is a policy engine that decides, for each agent-authored pull request, whether to **auto-merge**, **escalate** to a human, or **block** — combining deterministic gates with narrowly scoped LLM evaluators.

The goal is a productivity gain: coding agents can land safe changes (test-only, docs, flag-gated features, verified bug fixes) without a human in the loop, while anything uncertain fails closed to human review.

v1 is for personal use on my own repos. A visual flowchart editor and a multi-user product come later; v1 proves the engine, the policy format and the trust model.

## Core model

A policy is a directed graph a PR flows through; every path ends in `merge`, `escalate` or `block`. Gates are authoritative, evaluators are advisory, and the system fails closed.

| Node type | What it does                                                                                                                 | Examples                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Gate      | Deterministic pass/fail check                                                                                                | CI green, paths match `**/test/**`, diff under N lines, no migrations, flag exists and defaults off |
| Evaluator | LLM answers one narrow question; returns structured JSON: verdict, confidence, evidence (file + line refs) — never free text | "Is all new behaviour reachable only when flag X is on?", "Were any assertions weakened?"           |
| Router    | Branches and combinators                                                                                                     | AND/OR, route by declared category, threshold on evaluator confidence                               |

Rules the engine must enforce:

- An evaluator can push a PR towards escalation but can never override a failed gate.
- Evaluator error, timeout, malformed output or confidence below threshold → `escalate`.
- Any PR that matches no category → `escalate` (the fallback).
- Every decision is logged: path taken, each gate result, each evaluator verdict with evidence, policy version, model version, head SHA.
- Evaluator results are cached per head SHA so CI retries don't re-run LLM calls.

## Agent-authored PRs

PRs are written by coding agents, so the main risk is reward hacking — the agent "succeeding" in ways that look fine but aren't — rather than malicious authors.

**Default gates on every path:**

- Test count and assertion count must not drop.
- No newly added skips (`skip`, `@Disabled`, `.only`, `// eslint-disable`, etc.).
- Changed production lines are covered by tests.
- Files touched stay within the scope expected for the declared category.

**Declared intent:** the task that spawned the PR declares a category (e.g. `test_only`, `bugfix` with an issue ref, `flagged_feature` with a flag name), attached as PR metadata. The first node routes on it. It is a claim to verify, never trusted — a "test-only" PR touching `src/` escalates.

**Untrusted input:** PR descriptions, commit messages and code comments are attacker-controllable. Evaluators receive the diff plus gate-computed facts only, never the author's description or reasoning.

**Reviewer independence:** evaluators run in a fresh context, ideally a different model or at least a different prompt from the authoring agent, to avoid correlated blind spots.

**Reversibility:** auto-merge only changes that are cleanly revertable (no migrations, data writes or external side effects). After merge, watch main's CI and auto-revert if it goes red.

## Policy format

Policies live as versioned YAML in the repo (e.g. `.windlass/policy.yaml`). The future flowchart UI is a view over this file, not the source of truth; changes to the policy file itself must always escalate.

Starting sketch — the schema should evolve from real use:

```yaml
policy: v1
defaults:
  always:
    - gate: no_test_weakening
    - gate: no_new_skips
    - gate: ci_green
  on_evaluator_error: escalate

categories:
  docs_only:
    gates:
      - paths_only: ["**/*.md", "docs/**"]
    outcome: merge

  test_only:
    gates:
      - paths_only: ["**/test/**", "**/*_test.go"]
    outcome: merge

  flagged_feature:
    gates:
      - flag_referenced: { from: task.flag }
      - flag_defaults_off: { from: task.flag }
      - no_migrations
    evaluators:
      - id: fully_flag_gated
        min_confidence: 0.85
    outcome: merge

  bugfix:
    gates:
      - linked_issue
      - new_test_fails_on_base
      - new_test_passes_on_head
    outcome: merge

fallback: escalate
```

The bugfix gates are the key trick: run the PR's new or changed test against the base branch and require it to fail, then require it to pass on head. That proves the test reproduces the bug and the fix resolves it, deterministically.

## Architecture for v1

v1 is a GitHub Action plus a small engine library — no server, no database, no UI. Language: TypeScript (Node, Octokit). Keep the engine independent of the Action wrapper so it can later run as a GitHub App or CLI, and export the policy types for the future React Flow editor.

Flow per PR event:

1. Action triggers on `pull_request` (opened, synchronize) and on CI completion.
2. Load the policy YAML from the base branch (never from the PR head, so a PR can't rewrite its own policy).
3. Read declared intent from the fenced `windlass` block in the PR body (see Decisions).
4. Compute facts: changed files, diff stats, test/assertion counts on base vs head, skip markers, coverage of changed lines, CI status.
5. Walk the graph: always-gates, then the category's gates, then its evaluators.
6. Evaluators call an LLM with the diff and computed facts only, using a structured output schema; validate the response, and treat anything invalid as an error.
7. Emit a decision record (JSON) and post a PR comment showing the path taken and the reasons.
8. Merge only when shadow mode is off and outcome is `merge`; otherwise label for review.

Components to build: policy parser and validator, fact collectors, gate registry, evaluator runner, graph walker, decision record, GitHub adapter (comments, labels, merge), and a test harness that runs policies against fixture diffs without GitHub.

## Phased plan

Each phase ships something usable and gates the next on real evidence.

1. **Gates only, shadow mode.** Engine, policy parser, default gates and `docs_only`/`test_only` categories. Posts verdicts as PR comments; never merges. Run for \~2 weeks and note disagreements.
2. **Auto-merge boring categories.** Enable real merges for docs-only, test-only and dependency patch bumps — decided by gates alone, no LLM. Add post-merge CI watch and auto-revert.
3. **Evaluators, one at a time.** Start with `fully_flag_gated`, then a test-weakening evaluator. Log every call for replay. Add the bugfix base/head test gates.
4. **Backtesting, then the visual editor.** Replay the policy over historical merged PRs and flag any that would have auto-merged but were later reverted. Then build the flowchart UI (React + React Flow) over the now-stable YAML schema.

**First task for the coding agent:** scaffold the engine as a library with the policy parser and validator, the fact collector for changed files and diff stats, the `paths_only`, `ci_green` and `no_new_skips` gates, the graph walker, and the decision record. Include a fixture-based test harness (sample diffs → expected outcome). No GitHub integration and no LLM calls yet.

## Metrics, non-goals and decisions

**Metrics to track from day one:** share of agent PRs auto-merged; auto-merged PRs later reverted or needing a follow-up fix (the number that decides whether to loosen or tighten rules); escalation rate per category and per node.

**Non-goals for v1:** visual editor, multi-repo or multi-user support, GitLab, hosted service, billing.

**Decisions:**

- **Name:** Windlass. Repo `windlass` under my own GitHub account (the `windlass` org is taken); npm package scoped, e.g. `@<me>/windlass`; config in `.windlass/policy.yaml`. If the Actions Marketplace name is taken, list the Action as "Windlass PR Policy".
- **Language:** TypeScript, packaged as a JavaScript GitHub Action.
- **Pilot repo:** Reelshelf. Prerequisites: its CI emits an lcov report, and the agents opening PRs there include the `windlass` block.
- **Declared intent:** a fenced block in the PR body, e.g.

  ```windlass
  category: bugfix
  issue: 42
  ```

  The engine reads only the category and its references (`issue`, `flag`). A missing or malformed block escalates. The PR body is never passed to evaluators.

- **Evaluator model:** configurable per evaluator in the policy (`model:`), defaulting to a different model from the authoring agent, run in a fresh context with schema-validated structured outputs. The model ID goes in the decision record.
- **Coverage of changed lines:** consume the lcov report produced by the repo's CI and intersect it with the diff's changed lines. No report means the gate errors and the PR escalates. v1 supports lcov only.
