import { z } from "zod";
import type { Evidence } from "./types.js";
import { globMatcher } from "./paths.js";
import { defineGate } from "./types.js";

export interface SkipMarker {
  id: string;
  pattern: RegExp;
}

/**
 * Markers that skip, focus or silence tests, linters, type checks or coverage.
 * An agent adding one of these is the classic way to "make CI green".
 */
export const SKIP_MARKERS: readonly SkipMarker[] = [
  // JS/TS test runners (jest, vitest, mocha, bun:test): it.skip, describe.only, test.todo, test.skipIf(...)
  {
    id: "js-test-modifier",
    pattern: /\b(?:it|test|describe|context|suite|specify|bench)(?:\.\w+)*\.(?:skip|only|todo|skipIf|runIf|fails)\b/,
  },
  { id: "js-test-prefix", pattern: /\b(?:xit|xtest|xdescribe|xcontext|xspecify|fit|fdescribe)\s*\(/ },
  {
    id: "lint-suppression",
    pattern: /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore|oxlint-disable|tslint:disable/,
  },
  { id: "coverage-ignore", pattern: /\b(?:istanbul|c8|v8) ignore\b|pragma:\s*no cover|ExcludeFromCodeCoverage/ },
  // JUnit / TestNG / Kotlin
  { id: "jvm-disabled", pattern: /@(?:Disabled|Ignore)\b|@Test\s*\([^)]*\benabled\s*=\s*false/ },
  {
    id: "python-skip",
    pattern:
      /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\.skipTest\s*\(/,
  },
  { id: "python-suppression", pattern: /#\s*(?:noqa\b|type:\s*ignore\b|pyright:\s*ignore\b|pylint:\s*disable)/ },
  { id: "go-skip", pattern: /\b[tb]\.(?:Skip|SkipNow|Skipf)\s*\(|\/\/\s*nolint\b/ },
  // xUnit, NUnit, MSTest
  {
    id: "dotnet-skip",
    pattern:
      /\[\s*(?:Fact|Theory|SkippableFact|SkippableTheory)\s*\([^)]*\bSkip\s*=|\[\s*(?:Ignore|Explicit)\b|\bSkip\.(?:If|IfNot)\s*\(|\bAssert\.Inconclusive\s*\(/,
  },
  { id: "dotnet-suppression", pattern: /#pragma\s+warning\s+disable|\[\s*(?:assembly:\s*)?SuppressMessage\b/ },
  { id: "rust-ignore", pattern: /#\[ignore\b|#!?\[allow\s*\(/ },
];

/** Source files the markers are checked in; docs and data files may mention markers freely. */
const CODE_FILES = globMatcher([
  "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue,svelte}",
  "**/*.{py,pyi,go,java,kt,kts,scala,groovy,cs,fs,vb,rs,rb,php,swift,c,cc,cpp,cxx,h,hpp}",
]);

/**
 * Fails when the diff adds a skip/focus/suppression marker. Lines that were
 * only moved (the same text is removed elsewhere in the diff) don't count.
 *
 * - `extra`: additional regular expressions to treat as markers.
 * - `ignore_paths`: globs of files not to check.
 */
export const noNewSkips = defineGate({
  name: "no_new_skips",
  description: "No newly added test skips, focused tests or lint/type/coverage suppressions",
  defaultOnFail: "block",
  args: z
    .strictObject({
      extra: z
        .array(
          z.string().refine((source) => {
            try {
              new RegExp(source);
              return true;
            } catch {
              return false;
            }
          }, "must be a valid regular expression"),
        )
        .optional(),
      ignore_paths: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  run({ facts, args }) {
    const markers = [
      ...SKIP_MARKERS,
      ...(args?.extra ?? []).map((source, i) => ({ id: `extra[${i}]`, pattern: new RegExp(source) })),
    ];
    const ignored = globMatcher(args?.ignore_paths ?? []);
    const files = facts.files.filter((file) => CODE_FILES(file.path) && !ignored(file.path));

    // Removed marker lines anywhere in the diff offset added ones with the same text.
    const removed = new Map<string, number>();
    for (const file of files) {
      for (const { text } of file.removedLines) {
        if (markerOf(text, markers)) removed.set(text.trim(), (removed.get(text.trim()) ?? 0) + 1);
      }
    }

    const evidence: Evidence[] = [];
    for (const file of files) {
      for (const { line, text } of file.addedLines) {
        const marker = markerOf(text, markers);
        if (!marker) continue;
        const key = text.trim();
        const offset = removed.get(key) ?? 0;
        if (offset > 0) {
          removed.set(key, offset - 1);
          continue;
        }
        evidence.push({ file: file.path, line, detail: `${marker.id}: ${key}` });
      }
    }

    if (evidence.length === 0) return { status: "pass", reason: "no new skip or suppression markers" };
    return {
      status: "fail",
      reason: `${evidence.length} new skip or suppression marker(s) added`,
      evidence,
    };
  },
});

function markerOf(text: string, markers: readonly SkipMarker[]): SkipMarker | undefined {
  return markers.find((marker) => marker.pattern.test(text));
}
