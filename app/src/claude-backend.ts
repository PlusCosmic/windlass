import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobResult } from "./evaluations.js";
import type { ModelBackend } from "./runner.js";

/** The one tool the CLI may offer the model: the one it returns its structured answer through. */
const ANSWER_TOOL = "StructuredOutput";

/** Says the model was never asked: signed out, or the plan's usage limit is spent. */
const UNAVAILABLE =
  /not logged in|\/login|usage limit|session limit|weekly limit|rate limit|credit balance|overloaded/i;

/** What the backend uses of the Agent SDK, so tests can stand in for it. */
export type QueryFn = (input: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

export interface SdkMessage {
  type: string;
  subtype?: string;
  tools?: string[];
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  modelUsage?: Record<string, unknown>;
  model?: string;
}

/**
 * Asks Claude through the Claude Agent SDK, which runs the Claude Code CLI and
 * so can use a Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude
 * setup-token`) instead of an API key.
 *
 * The diff in the prompt is attacker-controlled, so the model gets nothing to
 * act with. Built-in tools, skills, settings files and session files are all
 * off, the CLI runs in an empty directory with an environment that holds only
 * its own credential, and if it reports any tool besides the answer tool the
 * question is abandoned before the model sees it.
 */
export function claudeBackend(options: { env?: NodeJS.ProcessEnv; query?: QueryFn } = {}): ModelBackend {
  const env = options.env ?? process.env;
  let query = options.query;
  let cwd: string | undefined;

  return {
    name: "claude",
    async ask(job, signal): Promise<JobResult> {
      // Loaded here, not at the top: only the runner needs the SDK, and the App's process never loads it.
      query ??= (await import("@anthropic-ai/claude-agent-sdk")).query as unknown as QueryFn;
      cwd ??= mkdtempSync(join(tmpdir(), "windlass-runner-"));

      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        let servedBy = job.model;
        for await (const message of query({
          prompt: job.user,
          options: {
            model: job.model,
            systemPrompt: job.system,
            outputFormat: { type: "json_schema", schema: job.schema },
            tools: [],
            skills: [],
            settingSources: [],
            persistSession: false,
            // One turn to answer, and room for the CLI to ask again if the answer misses the schema.
            maxTurns: 4,
            cwd,
            env: cliEnvironment(env),
            abortController: abort,
          },
        })) {
          if (message.type === "system" && message.subtype === "init") {
            const extra = (message.tools ?? []).filter((tool) => tool !== ANSWER_TOOL);
            if (extra.length > 0) {
              abort.abort();
              return {
                ok: false,
                kind: "error",
                message: `the CLI offered tools it must not have: ${extra.join(", ")}`,
              };
            }
            if (typeof message.model === "string") servedBy = message.model;
          }
          if (message.type !== "result") continue;

          const text = typeof message.result === "string" ? message.result : "";
          if (message.subtype !== "success" || message.is_error) {
            const detail = text || message.subtype || "the CLI reported an error";
            return { ok: false, kind: UNAVAILABLE.test(detail) ? "unavailable" : "error", message: detail };
          }
          if (message.structured_output === undefined) {
            return { ok: false, kind: "error", message: "the model gave no structured answer" };
          }
          const served = Object.keys(message.modelUsage ?? {});
          return { ok: true, model: served.length === 1 ? served[0]! : servedBy, output: message.structured_output };
        }
        return { ok: false, kind: "error", message: "the CLI ended without a result" };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (signal.aborted) return { ok: false, kind: "error", message: "timed out waiting for the model" };
        return { ok: false, kind: UNAVAILABLE.test(detail) ? "unavailable" : "error", message: detail };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** The CLI's whole environment: where it is, where it may write, and its own credential. */
function cliEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  // Either credential works: a subscription's token from `claude setup-token`, or an API key.
  const keep = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR",
  ];
  const out: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: "windlass-runner" };
  for (const name of keep) {
    const value = env[name];
    if (value) out[name] = value;
  }
  return out;
}
