import type { ChangedFile, DiffStats } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a unified diff (git's format, as served by `git diff` and the GitHub
 * API) into per-file changes with line-numbered added and removed lines.
 * Throws on input it can't make sense of, so callers fail closed.
 */
export function parseDiff(diff: string): ChangedFile[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const files: ChangedFile[] = [];
  let file: ChangedFile | null = null;
  // Paths from `---`/`+++` lines; null stands for /dev/null.
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;

  const finish = () => {
    if (!file) return;
    if (oldPath !== undefined || newPath !== undefined) {
      if (oldPath === null) file.status = "added";
      if (newPath === null) file.status = "deleted";
      if (file.status === "deleted") {
        file.path = oldPath ?? file.path;
      } else {
        file.path = newPath ?? file.path;
        if (oldPath && oldPath !== file.path) file.previousPath ??= oldPath;
      }
    }
    if (!file.path) throw new Error("diff: could not determine a file path");
    if (file.previousPath === file.path) delete file.previousPath;
    files.push(file);
    file = null;
  };

  const start = (path: string) => {
    finish();
    oldPath = undefined;
    newPath = undefined;
    file = {
      path,
      status: "modified",
      binary: false,
      additions: 0,
      deletions: 0,
      addedLines: [],
      removedLines: [],
    };
    return file;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = stripCr(lines[i]!);

    if (line.startsWith("diff --git ")) {
      start(headerPath(line.slice("diff --git ".length)));
      continue;
    }

    // A plain unified diff (no `diff --git` line) starts each file at `---`.
    if (line.startsWith("--- ") && stripCr(lines[i + 1] ?? "").startsWith("+++ ")) {
      const current = file as ChangedFile | null;
      if (!current || oldPath !== undefined) start("");
      oldPath = markerPath(line.slice(4));
      newPath = markerPath(stripCr(lines[++i]!).slice(4));
      continue;
    }

    const current = file as ChangedFile | null;
    if (!current) {
      // Preamble before the first file (e.g. `git format-patch` headers) is ignored.
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      let oldLine = Number(hunk[1]);
      let newLine = Number(hunk[3]);
      let oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      let newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      while (oldLeft > 0 || newLeft > 0) {
        const raw = lines[++i];
        if (raw === undefined) throw new Error(`diff: hunk in ${current.path || "file"} ends early`);
        const body = stripCr(raw);
        const marker = body[0];
        const text = body.slice(1);
        if (marker === "+") {
          current.addedLines.push({ line: newLine++, text });
          newLeft--;
        } else if (marker === "-") {
          current.removedLines.push({ line: oldLine++, text });
          oldLeft--;
        } else if (marker === " " || body === "") {
          // Some tools drop the leading space from empty context lines.
          oldLine++;
          newLine++;
          oldLeft--;
          newLeft--;
        } else if (marker === "\\") {
          // "\ No newline at end of file"
        } else {
          throw new Error(`diff: unexpected line in hunk of ${current.path || "file"}: ${JSON.stringify(body)}`);
        }
        if (oldLeft < 0 || newLeft < 0) throw new Error(`diff: hunk in ${current.path || "file"} overruns its header`);
      }
      // A trailing "\ No newline at end of file" belongs to the last line of the hunk.
      if (stripCr(lines[i + 1] ?? "").startsWith("\\")) i++;
      continue;
    }

    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.previousPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      current.status = "copied";
      current.previousPath = unquote(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      current.status = "copied";
      current.path = unquote(line.slice("copy to ".length));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
    }
  }
  finish();

  for (const f of files) {
    f.additions = f.addedLines.length;
    f.deletions = f.removedLines.length;
  }
  return files;
}

export function diffStats(files: ChangedFile[]): DiffStats {
  return {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Path from a `---`/`+++` line, without its `a/`/`b/` prefix; null for /dev/null. */
function markerPath(rest: string): string | null {
  // Non-git diffs may append a tab and a timestamp.
  const raw = rest.startsWith('"') ? rest : rest.split("\t")[0]!;
  const path = unquote(raw);
  if (path === "/dev/null") return null;
  return stripPrefix(path);
}

/**
 * Best-effort path from a `diff --git a/x b/y` header. Only used when the diff
 * has no `---`/`+++` or rename lines (binary files, mode-only changes).
 */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    const [, second] = splitQuoted(rest);
    return stripPrefix(second);
  }
  // Unquoted paths may contain spaces; for a non-rename the two halves are identical.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (stripPrefix(a) === stripPrefix(b)) return stripPrefix(b);
  }
  const split = rest.indexOf(" b/");
  return stripPrefix(split === -1 ? rest : rest.slice(split + 1));
}

function splitQuoted(rest: string): [string, string] {
  let i = 1;
  while (i < rest.length && !(rest[i] === '"' && rest[i - 1] !== "\\")) i++;
  const first = unquote(rest.slice(0, i + 1));
  const second = rest.slice(i + 2);
  return [first, unquote(second)];
}

function stripPrefix(path: string): string {
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

/** Undoes git's C-style quoting of paths with special characters. */
function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i]!;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i, i + 3);
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
