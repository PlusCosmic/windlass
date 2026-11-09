import { describe, expect, it } from "vitest";
import { diffStats, parseDiff } from "./diff.js";

describe("parseDiff", () => {
  it("numbers added lines on head and removed lines on base", () => {
    const [file] = parseDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,3 +10,4 @@ function f() {",
        " one",
        "-two",
        "+TWO",
        "+three",
        " four",
      ].join("\n"),
    );
    expect(file).toMatchObject({
      path: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      addedLines: [
        { line: 11, text: "TWO" },
        { line: 12, text: "three" },
      ],
      removedLines: [{ line: 11, text: "two" }],
    });
  });

  it("reads content lines that look like headers as content", () => {
    const [file, second] = parseDiff(
      [
        "diff --git a/notes.md b/notes.md",
        "--- a/notes.md",
        "+++ b/notes.md",
        "@@ -1,2 +1,2 @@",
        "--- old rule",
        "+++ new rule",
        " kept",
        "diff --git a/other.md b/other.md",
        "--- a/other.md",
        "+++ b/other.md",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
    );
    expect(file?.removedLines).toEqual([{ line: 1, text: "-- old rule" }]);
    expect(file?.addedLines).toEqual([{ line: 1, text: "++ new rule" }]);
    expect(second?.path).toBe("other.md");
  });

  it("handles added, deleted, renamed and binary files", () => {
    const files = parseDiff(
      [
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1 @@",
        "+export {};",
        "\\ No newline at end of file",
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "--- a/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        "diff --git a/src/x.ts b/lib/x.ts",
        "similarity index 100%",
        "rename from src/x.ts",
        "rename to lib/x.ts",
        "diff --git a/logo.png b/logo.png",
        "Binary files a/logo.png and b/logo.png differ",
      ].join("\n"),
    );
    expect(files.map(({ path, previousPath, status, binary }) => ({ path, previousPath, status, binary }))).toEqual([
      { path: "new.ts", previousPath: undefined, status: "added", binary: false },
      { path: "old.ts", previousPath: undefined, status: "deleted", binary: false },
      { path: "lib/x.ts", previousPath: "src/x.ts", status: "renamed", binary: false },
      { path: "logo.png", previousPath: undefined, status: "modified", binary: true },
    ]);
    expect(diffStats(files)).toEqual({ files: 4, additions: 1, deletions: 1 });
  });

  it("handles paths with spaces and git's quoting", () => {
    const files = parseDiff(
      [
        "diff --git a/my docs/a b.md b/my docs/a b.md",
        "Binary files differ",
        'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
        'Binary files "a/caf\\303\\251.md" and "b/caf\\303\\251.md" differ',
      ].join("\n"),
    );
    expect(files.map((f) => f.path)).toEqual(["my docs/a b.md", "café.md"]);
  });

  it("accepts plain unified diffs without git headers", () => {
    const files = parseDiff(
      [
        "--- a/a.txt\t2026-01-01",
        "+++ b/a.txt\t2026-01-02",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -1 +1 @@",
        "-c",
        "+d",
      ].join("\n"),
    );
    expect(files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("tolerates CRLF line endings", () => {
    const [file] = parseDiff("--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n");
    expect(file?.addedLines).toEqual([{ line: 1, text: "b" }]);
  });

  it("throws on a truncated hunk", () => {
    expect(() => parseDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n a\n")).toThrow(/ends early/);
  });

  it("returns no files for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
