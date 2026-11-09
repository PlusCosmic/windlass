import { describe, expect, it } from "vitest";
import { diffStats } from "../facts/diff.js";
import type { ChangedFile, CheckRun, Facts } from "../facts/types.js";
import { ciGreen } from "./ci-green.js";
import { noNewSkips } from "./no-new-skips.js";
import { pathsOnly } from "./paths-only.js";

function file(
  path: string,
  added: string[] = [],
  removed: string[] = [],
  extra: Partial<ChangedFile> = {},
): ChangedFile {
  return {
    path,
    status: "modified",
    binary: false,
    additions: added.length,
    deletions: removed.length,
    addedLines: added.map((text, i) => ({ line: i + 1, text })),
    removedLines: removed.map((text, i) => ({ line: i + 1, text })),
    ...extra,
  };
}

function facts(files: ChangedFile[], checks?: CheckRun[]): Facts {
  return { baseSha: "b", headSha: "h", diff: "", files, stats: diffStats(files), ci: checks ? { checks } : null };
}

describe("paths_only", () => {
  const run = (files: ChangedFile[], args: string[]) => pathsOnly.run({ facts: facts(files), intent: null, args });

  it("passes when every file matches", () => {
    expect(run([file("README.md"), file("docs/a/b.txt")], ["**/*.md", "docs/**"])).toMatchObject({ status: "pass" });
  });

  it("matches dotfile directories", () => {
    expect(run([file(".github/notes.md")], ["**/*.md"])).toMatchObject({ status: "pass" });
  });

  it("lists every file outside the globs", () => {
    const result = run([file("README.md"), file("src/a.ts"), file("src/b.ts")], ["**/*.md"]);
    expect(result).toMatchObject({ status: "fail" });
    if (result instanceof Promise) throw new Error("unexpected async gate");
    expect(result.evidence?.map((e) => e.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("checks the old side of a rename", () => {
    const renamed = file("docs/a.md", [], [], { status: "renamed", previousPath: "src/a.ts" });
    expect(run([renamed], ["**/*.md", "docs/**"])).toMatchObject({ status: "fail" });
  });

  it("errors on an empty diff rather than passing vacuously", () => {
    expect(run([], ["**"])).toMatchObject({ status: "error" });
  });
});

describe("ci_green", () => {
  const ok = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success" });
  const run = (checks: CheckRun[] | undefined, args?: { required?: string[]; ignore?: string[] }) =>
    ciGreen.run({ facts: facts([], checks), intent: null, args });

  it("passes when every check succeeded, was skipped or neutral", () => {
    expect(
      run([
        ok("build"),
        { name: "lint", status: "completed", conclusion: "skipped" },
        { name: "x", status: "completed", conclusion: "neutral" },
      ]),
    ).toMatchObject({ status: "pass" });
  });

  it("fails on any failed check, even with others still running", () => {
    expect(
      run([
        { name: "test", status: "completed", conclusion: "timed_out" },
        { name: "e2e", status: "in_progress" },
      ]),
    ).toMatchObject({ status: "fail" });
  });

  it("is pending while checks are running", () => {
    expect(run([ok("build"), { name: "test", status: "queued" }])).toMatchObject({ status: "pending" });
  });

  it("is pending until required checks report", () => {
    expect(run([ok("build")], { required: ["build", "test"] })).toMatchObject({
      status: "pending",
      reason: "waiting on CI: test",
    });
    expect(run([ok("build"), ok("test")], { required: ["build", "test"] })).toMatchObject({ status: "pass" });
  });

  it("ignores named checks, such as Windlass's own", () => {
    expect(run([ok("build"), { name: "windlass", status: "in_progress" }], { ignore: ["windlass"] })).toMatchObject({
      status: "pass",
    });
  });

  it("errors when CI wasn't collected or nothing reported", () => {
    expect(run(undefined)).toMatchObject({ status: "error" });
    expect(run([])).toMatchObject({ status: "error" });
  });
});

describe("no_new_skips", () => {
  const run = (files: ChangedFile[], args?: { extra?: string[]; ignore_paths?: string[] }) => {
    const result = noNewSkips.run({ facts: facts(files), intent: null, args });
    if (result instanceof Promise) throw new Error("unexpected async gate");
    return result;
  };

  it.each([
    ["test/a.test.ts", '  it.skip("works", () => {'],
    ["test/a.test.ts", '  describe.only("suite", () => {'],
    ["test/a.test.ts", '  test.todo("later");'],
    ["test/a.test.ts", '  test.skipIf(process.env.CI)("flaky", () => {'],
    ["test/a.test.ts", '  xit("works", () => {'],
    ["src/a.ts", "  // eslint-disable-next-line @typescript-eslint/no-explicit-any"],
    ["src/a.ts", "  // @ts-expect-error"],
    ["src/a.ts", "  /* istanbul ignore next */"],
    ["src/a.ts", "  /* v8 ignore next 3 */"],
    ["src/A.java", "  @Disabled"],
    ["tests/test_a.py", "@pytest.mark.skip(reason='flaky')"],
    ["src/a.py", "x = f()  # type: ignore"],
    ["a_test.go", '  t.Skip("flaky")'],
    ["Tests/ATests.cs", '  [Fact(Skip = "flaky")]'],
    ["Tests/ATests.cs", "  [Ignore]"],
    ["src/A.cs", "#pragma warning disable CS8618"],
    ["src/lib.rs", "#[ignore]"],
  ])("flags a new marker in %s: %s", (path, line) => {
    expect(run([file(path, [line])])).toMatchObject({ status: "fail" });
  });

  it.each([
    ["test/a.test.ts", '  it("skips nothing", () => {'],
    ["src/a.ts", "const skip = items.skip(2);"],
    ["src/a.ts", "const testOnly = true;"],
  ])("leaves ordinary code alone in %s: %s", (path, line) => {
    expect(run([file(path, [line])])).toMatchObject({ status: "pass" });
  });

  it("ignores markers in non-code files", () => {
    expect(run([file("README.md", ["Never use `it.skip`."])])).toMatchObject({ status: "pass" });
  });

  it("doesn't count markers that were only moved, even across files", () => {
    const line = '  it.skip("flaky", () => {';
    expect(run([file("test/a.test.ts", [], [line]), file("test/b.test.ts", [line])])).toMatchObject({ status: "pass" });
  });

  it("counts a second copy of a moved marker as new", () => {
    const line = '  it.skip("flaky", () => {';
    expect(run([file("test/a.test.ts", [line, line], [line])])).toMatchObject({ status: "fail" });
  });

  it("reports the file, line and marker as evidence", () => {
    const result = run([file("test/a.test.ts", ["ok", '  it.only("x", () => {'])]);
    expect(result.evidence).toEqual([
      { file: "test/a.test.ts", line: 2, detail: 'js-test-modifier: it.only("x", () => {' },
    ]);
  });

  it("supports extra patterns and ignored paths", () => {
    expect(run([file("src/a.ts", ["// HACK: skip validation"])], { extra: ["HACK:"] })).toMatchObject({
      status: "fail",
    });
    expect(run([file("vendor/x.ts", ["// eslint-disable"])], { ignore_paths: ["vendor/**"] })).toMatchObject({
      status: "pass",
    });
  });
});
