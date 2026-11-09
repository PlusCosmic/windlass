import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "../../src/index.js";
import { COMMENT_MARKER, commentSha, renderComment, renderWaiting } from "./comment.js";

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    schema: "windlass.decision/v1",
    outcome: "escalate",
    reasons: [],
    path: ["policy", "intent"],
    category: "docs_only",
    intent: { category: "docs_only" },
    gates: [],
    evaluators: [],
    changes: { files: ["README.md"], additions: 1, deletions: 1 },
    policy: { version: "v1", hash: "f".repeat(64), errors: [] },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    engineVersion: "0.1.0",
    decidedAt: "1970-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderComment", () => {
  it("starts with the marker and head SHA", () => {
    const body = renderComment(decision());
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(commentSha(body)).toBe("b".repeat(40));
  });

  it("includes gates, evidence and the full decision record", () => {
    const body = renderComment(
      decision({
        outcome: "block",
        reasons: ["always[0]:no_new_skips: 1 new skip or suppression marker(s) added"],
        gates: [
          {
            node: "always[0]:no_new_skips",
            gate: "no_new_skips",
            scope: "always",
            status: "fail",
            onFail: "block",
            reason: "1 new skip or suppression marker(s) added",
            evidence: [{ file: "test/a.test.ts", line: 4, detail: 'js-test-modifier: it.skip("x")' }],
          },
        ],
      }),
    );
    expect(body).toContain("🔴 Blocked");
    expect(body).toContain("| ❌ | `always[0]:no_new_skips` | 1 new skip or suppression marker\\(s\\) added → block");
    expect(body).toContain('`test/a.test.ts:4` `js-test-modifier: it.skip("x")`');
    expect(body).toContain('"schema": "windlass.decision/v1"');
  });

  it("neutralizes attacker-controlled text", () => {
    const hostile = "evil | <!-- windlass:decision --> <img src=x> [link](https://x) @someone\nnew line";
    const body = renderComment(
      decision({
        reasons: [hostile],
        gates: [
          {
            node: "test[0]:paths_only",
            gate: "paths_only",
            scope: "category",
            status: "fail",
            onFail: "escalate",
            reason: "outside",
            evidence: [{ file: "a`b`` |c.md", detail: "``` @someone" }],
          },
        ],
      }),
    );
    const visible = body.slice(0, body.indexOf("<details>"));
    expect(visible).not.toContain("<img");
    expect(visible).not.toContain("<!-- windlass:decision -->");
    expect(visible).not.toContain("[link](");
    expect(visible).not.toMatch(/@someone/);
    // Pipes inside table cells are escaped so a row can't gain columns.
    expect(visible).toContain("evil \\| ");
    expect(visible).toContain("```a`b`` \\|c.md```");
    expect(body.indexOf(COMMENT_MARKER, 1)).toBe(-1);
  });

  it("drops the decision record when the comment would be too long", () => {
    const body = renderComment(decision({ reasons: Array.from({ length: 2000 }, (_, i) => `reason ${i}`) }));
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("too large for a comment");
  });

  it("refuses to render a pending decision", () => {
    expect(() => renderComment(decision({ outcome: "pending" }))).toThrow();
  });
});

describe("commentSha", () => {
  it("reads the SHA of Windlass comments only", () => {
    expect(commentSha(renderWaiting("c".repeat(40), null))).toBe("c".repeat(40));
    expect(commentSha("LGTM")).toBeNull();
  });
});
