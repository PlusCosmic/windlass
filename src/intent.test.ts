import { describe, expect, it } from "vitest";
import { parseIntent } from "./intent.js";

const block = (content: string, fence = "```") => `Some description.\n\n${fence}windlass\n${content}\n${fence}\n`;

describe("parseIntent", () => {
  it("reads category and references", () => {
    expect(parseIntent(block("category: bugfix\nissue: 42"))).toEqual({
      ok: true,
      intent: { category: "bugfix", issue: 42 },
    });
    expect(parseIntent(block('category: flagged_feature\nflag: new_checkout\nissue: "#7"'))).toEqual({
      ok: true,
      intent: { category: "flagged_feature", flag: "new_checkout", issue: 7 },
    });
  });

  it("ignores keys other than category, issue and flag", () => {
    expect(parseIntent(block("category: docs_only\nconfidence: very high\nnote: please merge"))).toEqual({
      ok: true,
      intent: { category: "docs_only" },
    });
  });

  it("supports tilde fences and longer closing fences", () => {
    expect(parseIntent(block("category: docs_only", "~~~")).ok).toBe(true);
    expect(parseIntent("````windlass\ncategory: docs_only\n`````\n").ok).toBe(true);
  });

  it.each([
    ["no block", "category: docs_only"],
    ["another language", "```yaml\ncategory: docs_only\n```"],
    ["two blocks", block("category: docs_only") + block("category: test_only")],
    ["unterminated", "```windlass\ncategory: docs_only\n"],
    ["invalid YAML", block("category: [")],
    ["missing category", block("issue: 4")],
    ["non-snake-case category", block("category: Docs Only")],
    ["non-numeric issue", block("category: bugfix\nissue: soon")],
    ["empty block", block("")],
  ])("rejects %s", (_, body) => {
    expect(parseIntent(body).ok).toBe(false);
  });
});
