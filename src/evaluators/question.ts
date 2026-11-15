import type { Intent } from "../intent.js";

/** The references a question can take from the PR's declared intent. */
export const QUESTION_PLACEHOLDERS = ["flag", "issue"] as const;
export type QuestionPlaceholder = (typeof QUESTION_PLACEHOLDERS)[number];

export const MAX_QUESTION_LENGTH = 4000;

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Every `{{name}}` in a question, known or not, in order of first use. */
export function questionPlaceholders(question: string): string[] {
  return [...new Set([...question.matchAll(PLACEHOLDER)].map((match) => match[1]!))];
}

export function isQuestionPlaceholder(name: string): name is QuestionPlaceholder {
  return (QUESTION_PLACEHOLDERS as readonly string[]).includes(name);
}

export type ResolvedQuestion = { ok: true; question: string } | { ok: false; missing: QuestionPlaceholder[] };

/**
 * Fills a question's placeholders from the declared intent. A placeholder the
 * PR gave no value for can't be answered, so the caller escalates.
 *
 * The values are safe to put in a prompt: `parseIntent` only accepts a number
 * for `issue` and a plain key for `flag`.
 */
export function resolveQuestion(question: string, intent: Intent): ResolvedQuestion {
  const missing: QuestionPlaceholder[] = [];
  const resolved = question.replace(PLACEHOLDER, (whole, name: string) => {
    if (!isQuestionPlaceholder(name)) return whole;
    const value = intent[name];
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return String(value);
  });
  return missing.length > 0 ? { ok: false, missing } : { ok: true, question: resolved };
}
