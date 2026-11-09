import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The category a PR claims, read from the fenced `windlass` block in its body.
 * It's a claim to verify, never something to trust.
 */
export interface Intent {
  category: string;
  /** Issue number, for categories like `bugfix`. */
  issue?: number;
  /** Feature flag name, for categories like `flagged_feature`. */
  flag?: string;
}

export type IntentResult = { ok: true; intent: Intent } | { ok: false; reason: string };

const IntentSchema = z.object({
  category: z.string().regex(/^[a-z][a-z0-9_]*$/, "must be a snake_case category name"),
  issue: z
    .union([z.number().int().positive(), z.string().regex(/^#?\d+$/)])
    .transform((v) => (typeof v === "number" ? v : Number(v.replace("#", ""))))
    .optional(),
  flag: z.string().min(1).optional(),
});

// An opening fence of ``` or ~~~ whose info string is exactly `windlass`.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*windlass[ \t]*$/;

/**
 * Reads the declared intent from a PR body. Only `category`, `issue` and `flag`
 * are kept; everything else in the body is ignored. A missing, duplicated or
 * malformed block is an error, which the engine turns into an escalation.
 */
export function parseIntent(body: string): IntentResult {
  const blocks = findWindlassBlocks(body);
  if (blocks.length === 0) return { ok: false, reason: "no `windlass` block in the PR body" };
  if (blocks.length > 1) return { ok: false, reason: "more than one `windlass` block in the PR body" };
  if (blocks[0] === null) return { ok: false, reason: "the `windlass` block is never closed" };

  let raw: unknown;
  try {
    raw = parseYaml(blocks[0]!);
  } catch {
    return { ok: false, reason: "the `windlass` block is not valid YAML" };
  }

  const parsed = IntentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `\`${issue.path.join(".")}\`` : "block";
    return { ok: false, reason: `malformed \`windlass\` block: ${where} ${issue?.message ?? "is invalid"}` };
  }

  const { category, issue, flag } = parsed.data;
  const intent: Intent = { category };
  if (issue !== undefined) intent.issue = issue;
  if (flag !== undefined) intent.flag = flag;
  return { ok: true, intent };
}

/** Returns the content of each `windlass` block, or null for one that is never closed. */
function findWindlassBlocks(body: string): (string | null)[] {
  const lines = body.split(/\r?\n/);
  const blocks: (string | null)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    // Per CommonMark, the closing fence uses the same character and is at least as long.
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    const content: string[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      if (close.test(lines[i]!)) {
        closed = true;
        break;
      }
      content.push(lines[i]!);
    }
    blocks.push(closed ? content.join("\n") : null);
  }
  return blocks;
}
