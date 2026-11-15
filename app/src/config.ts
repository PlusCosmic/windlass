import { resolve } from "node:path";

/** The GitHub App's credentials, from the App's settings page. */
export interface GitHubAppConfig {
  appId: string;
  /** PEM. */
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

interface CommonConfig {
  port: number;
  host: string;
  dataDir: string;
  /** The built editor (`web/dist`). */
  webDir: string;
  policyPath: string;
}

/**
 * - `app`: the deployed GitHub App. Receives webhooks, and the editor needs a GitHub sign-in from `admins`.
 * - `dev`: local only. No webhooks and no sign-in, so it only ever listens on loopback. It reads GitHub with
 *   `GITHUB_TOKEN` when one is set (to import PRs) and never writes to it.
 */
export type Config =
  | (CommonConfig & {
      mode: "app";
      /** Public origin, e.g. `https://windlass.example.com`. */
      baseUrl: string;
      github: GitHubAppConfig;
      /** GitHub logins allowed to sign in, lower-cased. */
      admins: string[];
      sessionSecret: string;
    })
  | (CommonConfig & { mode: "dev"; githubToken: string | null });

const REQUIRED_FOR_APP = [
  "WINDLASS_BASE_URL",
  "WINDLASS_ADMINS",
  "WINDLASS_SESSION_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

/**
 * Reads the configuration from the environment. Anything short of a complete
 * App configuration is an error unless `WINDLASS_DEV=1` asks for dev mode, so a
 * half-configured deployment never serves the editor without a sign-in.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error(`PORT must be a port number, got ${env.PORT}`);

  const common = {
    port,
    dataDir: resolve(env.WINDLASS_DATA_DIR ?? ".data"),
    webDir: resolve(env.WINDLASS_WEB_DIR ?? "web/dist"),
    policyPath: env.WINDLASS_POLICY_PATH || ".windlass/policy.yaml",
  };

  if (env.WINDLASS_DEV === "1") {
    return { ...common, mode: "dev", host: "127.0.0.1", githubToken: env.GITHUB_TOKEN || null };
  }

  const missing = REQUIRED_FOR_APP.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(", ")} (set them, or WINDLASS_DEV=1 to run locally without GitHub)`);
  }
  const sessionSecret = env.WINDLASS_SESSION_SECRET!;
  if (sessionSecret.length < 32) throw new Error("WINDLASS_SESSION_SECRET must be at least 32 characters");
  const baseUrl = new URL(env.WINDLASS_BASE_URL!);
  if (baseUrl.protocol !== "https:") throw new Error("WINDLASS_BASE_URL must be an https URL");
  const admins = env
    .WINDLASS_ADMINS!.split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  if (admins.length === 0) throw new Error("WINDLASS_ADMINS names no one");

  return {
    ...common,
    mode: "app",
    host: env.HOST || "0.0.0.0",
    baseUrl: baseUrl.origin,
    admins,
    sessionSecret,
    github: {
      appId: env.GITHUB_APP_ID!,
      privateKey: readPrivateKey(env.GITHUB_APP_PRIVATE_KEY!),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET!,
      clientId: env.GITHUB_CLIENT_ID!,
      clientSecret: env.GITHUB_CLIENT_SECRET!,
    },
  };
}

/** Accepts the PEM as it is, with its newlines written as `\n`, or base64-encoded (the easiest to paste into an env tab). */
export function readPrivateKey(value: string): string {
  const pem = value.includes("BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
  if (!pem.includes("BEGIN")) throw new Error("GITHUB_APP_PRIVATE_KEY is neither a PEM nor a base64-encoded PEM");
  return pem.replace(/\\n/g, "\n").trim() + "\n";
}
