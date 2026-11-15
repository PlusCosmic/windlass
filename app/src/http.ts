import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Config } from "./config.js";
import { verifyWebhookSignature } from "./github-app.js";
import { ServiceError, type Service } from "./service.js";
import { createSession, readSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from "./session.js";
import type { Repo, Store } from "./store.js";

export interface HttpDeps {
  config: Config;
  store: Store;
  service: Service;
  /** Handles a verified webhook; absent in dev mode, which receives none. */
  onWebhook?: (event: string, payload: unknown) => Promise<string>;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

type Env = { Variables: { login: string } };

const STATE_COOKIE = "windlass_oauth_state";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const SimulateBody = z.object({ policy: z.string().max(200_000).nullable() });
const ProposeBody = z.object({ policy: z.string().min(1).max(200_000) });
const ImportBody = z.object({ limit: z.number().int().min(1).max(100).default(30) });

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createHttpApp(deps: HttpDeps): Hono<Env> {
  const { config, store, service } = deps;
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const app = new Hono<Env>();

  app.onError((error, c) => {
    if (error instanceof ServiceError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: "the request is malformed" }, 400);
    log(`error on ${c.req.method} ${c.req.path}: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
    return c.json({ error: "something went wrong" }, 500);
  });

  // Dev mode has no sign-in, so it answers only requests addressed to this machine by name. A page on
  // another site can make the browser connect to 127.0.0.1, but not with a loopback Host header.
  if (config.mode === "dev") {
    app.use(async (c, next) => {
      const host = new URL(c.req.url).hostname;
      if (!LOOPBACK.has(host)) return c.json({ error: "dev mode only answers on localhost" }, 403);
      await next();
    });
  }

  app.get("/health", (c) => c.json({ ok: true }));

  if (config.mode === "app") {
    const { github, baseUrl, sessionSecret, admins } = config;
    const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax" } as const;

    app.post("/webhooks/github", bodyLimit({ maxSize: 26 * 1024 * 1024 }), async (c) => {
      // The signature covers the bytes as sent, so verify before parsing anything.
      const body = await c.req.text();
      if (!verifyWebhookSignature(github.webhookSecret, body, c.req.header("x-hub-signature-256"))) {
        return c.json({ error: "bad signature" }, 401);
      }
      const event = c.req.header("x-github-event") ?? "";
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return c.json({ error: "the payload is not JSON" }, 400);
      }
      const result = deps.onWebhook ? await deps.onWebhook(event, payload) : "ignored";
      log(`webhook ${event}: ${result}`);
      return c.json({ result }, 202);
    });

    app.get("/auth/login", (c) => {
      const state = randomBytes(16).toString("hex");
      setCookie(c, STATE_COOKIE, state, { ...cookieOptions, path: "/auth", maxAge: 600 });
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", github.clientId);
      url.searchParams.set("redirect_uri", `${baseUrl}/auth/callback`);
      url.searchParams.set("state", state);
      return c.redirect(url.toString());
    });

    app.get("/auth/callback", async (c) => {
      const state = c.req.query("state");
      const code = c.req.query("code");
      const expected = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: "/auth" });
      if (!state || !code || !expected || state !== expected)
        return c.text("That sign-in link has expired. Try again.", 400);

      const tokenResponse = await doFetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, code }),
      });
      const token = z.object({ access_token: z.string() }).safeParse(await tokenResponse.json().catch(() => null));
      if (!token.success) return c.text("GitHub did not complete the sign-in. Try again.", 502);

      const userResponse = await doFetch("https://api.github.com/user", {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.data.access_token}` },
      });
      const user = z.object({ login: z.string() }).safeParse(await userResponse.json().catch(() => null));
      if (!userResponse.ok || !user.success) return c.text("GitHub did not say who signed in. Try again.", 502);

      if (!admins.includes(user.data.login.toLowerCase())) {
        log(`sign-in refused for ${user.data.login}`);
        return c.text("This account isn't allowed to use this Windlass.", 403);
      }
      setCookie(c, SESSION_COOKIE, createSession(sessionSecret, user.data.login), {
        ...cookieOptions,
        path: "/",
        maxAge: SESSION_TTL_SECONDS,
      });
      return c.redirect("/");
    });

    app.post("/auth/logout", (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    });
  }

  app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024 }), async (c, next) => {
    if (config.mode === "app") {
      const login = readSession(config.sessionSecret, getCookie(c, SESSION_COOKIE));
      // Checked against the list on every request, so removing someone takes effect on the next deploy.
      if (!login || !config.admins.includes(login.toLowerCase())) return c.json({ error: "sign in" }, 401);
      c.set("login", login);
    } else {
      c.set("login", "dev");
    }
    // The session cookie rides along on cross-site requests the browser lets through; only our own page may change things.
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(config, c.req.header("origin"))) {
      return c.json({ error: "cross-site request refused" }, 403);
    }
    await next();
  });

  app.get("/api/me", (c) =>
    c.json({ login: c.get("login"), mode: config.mode, policyPath: config.policyPath, gates: service.catalog() }),
  );

  app.get("/api/repos", (c) =>
    c.json(
      store.listRepos().map((repo) => ({
        owner: repo.owner,
        name: repo.name,
        connected: repo.installationId !== null,
        pulls: store.listPulls(repo.id).length,
      })),
    ),
  );

  const repoOf = (c: Context<Env>): Repo => {
    const repo = store.getRepo(c.req.param("owner") ?? "", c.req.param("name") ?? "");
    if (!repo) throw new ServiceError(404, "Windlass doesn't know that repository");
    return repo;
  };

  app.post("/api/repos/:owner/:name/simulate", async (c) => {
    const repo = repoOf(c);
    const { policy } = SimulateBody.parse(await c.req.json());
    return c.json({ source: repo.policySource, ...(await service.simulate(repo, policy)) });
  });

  app.post("/api/repos/:owner/:name/import", async (c) => {
    const repo = repoOf(c);
    const { limit } = ImportBody.parse(await c.req.json().catch(() => ({})));
    return c.json({ imported: await service.importPulls(repo, limit) });
  });

  app.post("/api/repos/:owner/:name/propose", async (c) => {
    const repo = repoOf(c);
    const { policy } = ProposeBody.parse(await c.req.json());
    const url = await service.proposePolicy(repo, policy);
    log(`${c.get("login")} proposed a policy for ${repo.owner}/${repo.name}: ${url}`);
    return c.json({ url });
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // The editor: built files by path, and index.html for everything else so its own URLs load.
  app.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    const file = await readStatic(config.webDir, path);
    if (file) {
      return c.body(file.body, 200, {
        "content-type": file.type,
        "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }
    const index = await readStatic(config.webDir, "/index.html");
    if (!index) return c.text("The editor hasn't been built (bun run build:web).", 404);
    return c.body(index.body, 200, { "content-type": index.type, "cache-control": "no-cache" });
  });

  return app;
}

function sameOrigin(config: Config, origin: string | undefined): boolean {
  if (config.mode === "app") return origin === config.baseUrl;
  // Dev: tools like curl send no Origin; a browser always does on a POST.
  if (origin === undefined) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function readStatic(root: string, path: string): Promise<{ body: Uint8Array<ArrayBuffer>; type: string } | null> {
  const type = CONTENT_TYPES[extname(path)];
  if (!type) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const full = normalize(join(root, decoded));
  if (!full.startsWith(root + sep)) return null;
  try {
    return { body: new Uint8Array(await readFile(full)), type };
  } catch {
    return null;
  }
}
