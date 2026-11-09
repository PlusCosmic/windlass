import picomatch from "picomatch";
import type { ChangedFile } from "../facts/types.js";

/** Builds a matcher for a list of globs. Dotfiles match, so `**` covers `.github/`. */
export function globMatcher(globs: readonly string[]): (path: string) => boolean {
  if (globs.length === 0) return () => false;
  return picomatch([...globs], { dot: true });
}

/** Every path a change touches: its head path and, for renames and copies, its base path. */
export function touchedPaths(file: ChangedFile): string[] {
  return file.previousPath ? [file.path, file.previousPath] : [file.path];
}
