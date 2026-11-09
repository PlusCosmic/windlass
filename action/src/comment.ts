import type { DecisionRecord, Evidence } from "../../src/index.js";

/** Every Windlass comment starts with this; the head SHA it describes follows it. */
export const COMMENT_MARKER = "<!-- windlass:decision";

// GitHub rejects comments over 65,536 characters; leave room for the markdown around the JSON.
const MAX_COMMENT_LENGTH = 60_000;
const MAX_EVIDENCE_PER_NODE = 10;

const HEADLINES: Record<"merge" | "escalate" | "block", string> = {
  merge: "🟢 Would merge (shadow mode: nothing was merged)",
  escalate: "🟡 Escalated for human review",
  block: "🔴 Blocked",
};

const STATUS_ICONS: Record<string, string> = {
  pass: "✅",
  fail: "❌",
  error: "⚠️",
  pending: "⏳",
  low_confidence: "❔",
  skipped: "⏭️",
};

/** The head SHA an existing Windlass comment describes, or null if it isn't one. */
export function commentSha(body: string): string | null {
  if (!body.startsWith(COMMENT_MARKER)) return null;
  return /^<!-- windlass:decision sha=([0-9a-f]+) -->/.exec(body)?.[1] ?? "";
}

/**
 * Renders a decision as a PR comment. Paths, reasons and evidence can contain
 * attacker-controlled text (file names, code), so everything dynamic is escaped
 * to stop it injecting HTML, links or @mentions.
 */
export function renderComment(decision: DecisionRecord): string {
  if (decision.outcome === "pending") throw new Error("pending decisions are not rendered");

  const lines: string[] = [
    `${COMMENT_MARKER} sha=${decision.headSha} -->`,
    `### Windlass: ${HEADLINES[decision.outcome]}`,
    "",
    [
      decision.category ? `category ${code(decision.category)}` : "no valid category",
      `head ${code(decision.headSha.slice(0, 7))}`,
      decision.policy.version
        ? `policy ${code(decision.policy.version)} (${code(decision.policy.hash.slice(0, 12))})`
        : "policy invalid",
      `engine ${code(decision.engineVersion)}`,
    ].join(" · "),
  ];

  if (decision.reasons.length > 0) {
    lines.push("", "**Reasons**", "", ...decision.reasons.map((reason) => `- ${text(reason)}`));
  }

  if (decision.policy.errors.length > 0) {
    lines.push(
      "",
      "**Policy errors**",
      "",
      ...decision.policy.errors.map((e) => `- ${e.path ? `${code(e.path)}: ` : ""}${text(e.message)}`),
    );
  }

  if (decision.gates.length > 0) {
    lines.push("", "**Gates**", "", "| | Node | Result |", "| --- | --- | --- |");
    for (const gate of decision.gates) {
      const failNote = gate.status === "fail" ? ` → ${gate.onFail}` : "";
      lines.push(
        `| ${STATUS_ICONS[gate.status]} | ${code(gate.node)} | ${text(gate.reason)}${failNote}${evidence(gate.evidence)} |`,
      );
    }
  }

  if (decision.evaluators.length > 0) {
    lines.push("", "**Evaluators**", "", "| | Node | Model | Result |", "| --- | --- | --- | --- |");
    for (const ev of decision.evaluators) {
      lines.push(
        `| ${STATUS_ICONS[ev.status]} | ${code(ev.node)} | ${ev.model ? code(ev.model) : "–"} | ${text(ev.reason)}${evidence(ev.evidence)} |`,
      );
    }
  }

  lines.push("", `<sub>Path: ${decision.path.map(code).join(" → ")}</sub>`);

  const head = lines.join("\n");
  // `<` escaped as \u003c keeps the JSON valid while ruling out any HTML in the record.
  const json = JSON.stringify(decision, null, 2).replace(/</g, "\\u003c");
  const fence = "`".repeat(Math.max(3, longestRun(json, "`") + 1));
  const record = ["", "<details><summary>Decision record</summary>", "", `${fence}json`, json, fence, "", "</details>"];
  const full = [head, ...record].join("\n");
  if (full.length <= MAX_COMMENT_LENGTH) return full;
  return [head, "", "<sub>The decision record is too large for a comment; see the workflow run's summary.</sub>"].join(
    "\n",
  );
}

/** Replaces an out-of-date decision while Windlass waits on CI for the new head. */
export function renderWaiting(headSha: string, previousSha: string | null): string {
  return [
    `${COMMENT_MARKER} sha=${headSha} -->`,
    "### Windlass: ⏳ Waiting on CI",
    "",
    `Re-evaluating head ${code(headSha.slice(0, 7))} once CI finishes.` +
      (previousSha ? ` The earlier decision for ${code(previousSha.slice(0, 7))} no longer applies.` : ""),
  ].join("\n");
}

function evidence(items: readonly Evidence[]): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, MAX_EVIDENCE_PER_NODE).map((e) => {
    const where = code(e.line === undefined ? e.file : `${e.file}:${e.line}`);
    return `${where} ${code(e.detail)}`;
  });
  if (items.length > MAX_EVIDENCE_PER_NODE) shown.push(`…and ${items.length - MAX_EVIDENCE_PER_NODE} more`);
  return `<br>${shown.join("<br>")}`;
}

/** Inline markdown for a table cell: no HTML, links, headings or @mentions. Backticks are kept for code spans. */
function text(value: string): string {
  return oneLine(value)
    .replace(/[\\*_[\]()#!~|]/g, (ch) => `\\${ch}`)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@​");
}

/** An inline code span that holds any text, including backticks, safely inside a table cell. */
function code(value: string): string {
  // Mentions don't fire inside code spans, but break them anyway in case of a rendering edge case.
  const content = oneLine(value).replace(/\|/g, "\\|").replace(/@/g, "@\u200b");
  const fence = "`".repeat(longestRun(content, "`") + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ");
}

function longestRun(value: string, ch: string): number {
  let longest = 0;
  let run = 0;
  for (const c of value) {
    run = c === ch ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}
