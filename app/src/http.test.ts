import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, readPrivateKey, type Config } from "./config.js";
import { appJwt, verifyWebhookSignature } from "./github-app.js";
import { Evaluations, hashRunnerToken } from "./evaluations.js";
import { createHttpApp } from "./http.js";
import { Service } from "./service.js";
import { createSession, readSession, SESSION_COOKIE } from "./session.js";
import { Store } from "./store.js";
import { accessTo, FakeGitHub, POLICY, pull } from "./testing.js";

const SECRET = "s".repeat(40);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const webDir = mkdtempSync(join(tmpdir(), "windlass-web-"));
mkdirSync(join(webDir, "assets"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Windlass</title>");
writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");
writeFileSync(join(webDir, "..", "secret.html"), "nope");

const appEnv = {
  WINDLASS_BASE_URL: "https://windlass.example",
  WINDLASS_ADMINS: "Harry, other",
  WINDLASS_SESSION_SECRET: SECRET,
  WINDLASS_WEB_DIR: webDir,
  WINDLASS_DATA_DIR: ":memory:",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
  GITHUB_WEBHOOK_SECRET: "hook",
  GITHUB_CLIENT_ID: "client",
  GITHUB_CLIENT_SECRET: "client-secret",
};

let store: Store;
let github: FakeGitHub;
let webhooks: [string, unknown][];

const RUNNER_TOKEN = "r".repeat(40);

function build(config: Config, fetchImpl?: typeof fetch) {
  store = new Store(":memory:");
  github = new FakeGitHub().add(pull(1));
  webhooks = [];
  const evaluations = config.runnerToken ? new Evaluations({ store }) : undefined;
  if (config.runnerToken) store.upsertRunner("default", hashRunnerToken(config.runnerToken), null);
  const service = new Service({
    store,
    github: accessTo(github),
    policyPath: config.policyPath,
    ...(evaluations && { evaluations }),
  });
  const repo = store.upsertRepo("acme", "app", 5);
  store.setPolicySource(repo.id, POLICY);
  return createHttpApp({
    config,
    store,
    service,
    ...(evaluations && { evaluations }),
    onWebhook: async (event, payload) => {
      webhooks.push([event, payload]);
      return "ok";
    },
    ...(fetchImpl && { fetch: fetchImpl }),
  });
}

const signedIn = { cookie: `${SESSION_COOKIE}=${createSession(SECRET, "Harry")}` };
const json = { "content-type": "application/json", origin: "https://windlass.example" };

describe("configuration", () => {
  it("refuses to start half-configured, so the editor is never served without a sign-in", () => {
    expect(() => loadConfig({})).toThrow(/missing WINDLASS_BASE_URL.*GITHUB_CLIENT_SECRET/);
    expect(() => loadConfig({ ...appEnv, WINDLASS_SESSION_SECRET: "short" })).toThrow("at least 32");
    expect(() => loadConfig({ ...appEnv, WINDLASS_BASE_URL: "http://windlass.example" })).toThrow("https");
  });

  it("only listens on loopback in dev mode", () => {
    expect(loadConfig({ WINDLASS_DEV: "1", HOST: "0.0.0.0" })).toMatchObject({ mode: "dev", host: "127.0.0.1" });
  });

  it("reads the private key however it was pasted", () => {
    expect(readPrivateKey(pem)).toBe(pem);
    expect(readPrivateKey(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(loadConfig(appEnv)).toMatchObject({ mode: "app", admins: ["harry", "other"], github: { privateKey: pem } });
    expect(() => readPrivateKey("bm90IGEga2V5")).toThrow("neither");
  });
});

describe("GitHub App credentials", () => {
  it("signs a JWT GitHub can verify, valid for under ten minutes", () => {
    const [header, payload, signature] = appJwt("123", pem, 1_000_000_000_000).split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims).toEqual({ iss: "123", iat: 999_999_940, exp: 1_000_000_540 });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature!, "base64url")).toBe(
      true,
    );
  });

  it("accepts only the signature made with the webhook secret", () => {
    const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyWebhookSignature("hook", "{}", sign("hook", "{}"))).toBe(true);
    expect(verifyWebhookSignature("hook", "{} ", sign("hook", "{}"))).toBe(false);
    expect(verifyWebhookSignature("hook", "{}", sign("other", "{}"))).toBe(false);
    expect(verifyWebhookSignature("hook", "{}", undefined)).toBe(false);
    expect(verifyWebhookSignature("hook", "{}", "sha256=abc")).toBe(false);
  });
});

describe("sessions", () => {
  it("round-trips, and rejects a forged or expired cookie", () => {
    const cookie = createSession(SECRET, "Harry", 0);
    expect(readSession(SECRET, cookie, 1000)).toBe("Harry");
    expect(readSession(SECRET, cookie, 8 * 24 * 3600 * 1000)).toBeNull();
    expect(readSession("x".repeat(40), cookie, 1000)).toBeNull();
    const forged = `${Buffer.from(JSON.stringify({ login: "Mallory", exp: 9e9 })).toString("base64url")}.${cookie.split(".")[1]}`;
    expect(readSession(SECRET, forged, 1000)).toBeNull();
    expect(readSession(SECRET, undefined)).toBeNull();
  });
});

describe("the deployed App", () => {
  let app: ReturnType<typeof build>;
  beforeEach(() => {
    app = build(loadConfig(appEnv));
  });

  it("keeps the API behind a sign-in", async () => {
    expect((await app.request("/api/repos")).status).toBe(401);
    expect((await app.request("/api/repos", { headers: { cookie: `${SESSION_COOKIE}=nonsense` } })).status).toBe(401);
    const response = await app.request("/api/repos", { headers: signedIn });
    expect(await response.json()).toEqual([{ owner: "acme", name: "app", connected: true, pulls: 0 }]);
  });

  it("stops serving someone removed from the admin list, whatever their cookie says", async () => {
    const cookie = `${SESSION_COOKIE}=${createSession(SECRET, "departed")}`;
    expect((await app.request("/api/repos", { headers: { cookie } })).status).toBe(401);
  });

  it("refuses changes that don't come from its own page", async () => {
    const body = JSON.stringify({ policy: null });
    const post = (headers: Record<string, string>) =>
      app.request("/api/repos/acme/app/simulate", { method: "POST", body, headers: { ...signedIn, ...headers } });
    expect((await post({ "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "content-type": "application/json" })).status).toBe(403);
    expect((await post(json)).status).toBe(200);
  });

  it("simulates a draft and proposes it as a pull request", async () => {
    const policy = POLICY.replace("outcome: merge", "outcome: escalate");
    const simulate = await app.request("/api/repos/acme/app/simulate", {
      method: "POST",
      body: JSON.stringify({ policy }),
      headers: { ...signedIn, ...json },
    });
    expect(await simulate.json()).toMatchObject({ source: POLICY, policy: { ok: true }, pulls: [] });

    const propose = await app.request("/api/repos/acme/app/propose", {
      method: "POST",
      body: JSON.stringify({ policy }),
      headers: { ...signedIn, ...json },
    });
    expect(await propose.json()).toEqual({ url: "https://github.com/acme/app/pull/99" });
    expect(github.proposals[0]?.content).toBe(policy);
  });

  it("answers plainly for bad requests and unknown repos", async () => {
    const post = (path: string, body: string) =>
      app.request(path, { method: "POST", body, headers: { ...signedIn, ...json } });
    expect((await post("/api/repos/acme/nope/simulate", "{}")).status).toBe(404);
    expect((await post("/api/repos/acme/app/simulate", '{"policy": 5}')).status).toBe(400);
    expect((await post("/api/repos/acme/app/propose", '{"policy": "policy: v9"}')).status).toBe(400);
    expect((await app.request("/api/nope", { headers: signedIn })).status).toBe(404);
  });

  it("takes webhooks only with a valid signature", async () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${createHmac("sha256", "hook").update(body).digest("hex")}`;
    const post = (headers: Record<string, string>) =>
      app.request("/webhooks/github", { method: "POST", body, headers });

    expect((await post({ "x-github-event": "pull_request" })).status).toBe(401);
    expect((await post({ "x-github-event": "pull_request", "x-hub-signature-256": "sha256=00" })).status).toBe(401);
    expect(webhooks).toEqual([]);

    const accepted = await post({ "x-github-event": "pull_request", "x-hub-signature-256": signature });
    expect(accepted.status).toBe(202);
    expect(webhooks).toEqual([["pull_request", { action: "opened" }]]);
  });

  it("signs in an admin through GitHub and turns everyone else away", async () => {
    const githubSays = (login: string): typeof fetch =>
      (async (url: string | URL | Request) =>
        Response.json(String(url).includes("access_token") ? { access_token: "t" } : { login })) as typeof fetch;

    const start = await build(loadConfig(appEnv)).request("/auth/login");
    const state = /windlass_oauth_state=([0-9a-f]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1];
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toContain(
      `client_id=client&redirect_uri=https%3A%2F%2Fwindlass.example%2Fauth%2Fcallback&state=${state}`,
    );

    const callback = (login: string, sent = state, cookie = state) =>
      build(loadConfig(appEnv), githubSays(login)).request(`/auth/callback?code=c&state=${sent}`, {
        headers: { cookie: `windlass_oauth_state=${cookie}` },
      });

    const admin = await callback("harry");
    expect(admin.status).toBe(302);
    const session = /windlass_session=([^;]+)/.exec(admin.headers.get("set-cookie") ?? "")?.[1];
    expect(readSession(SECRET, session)).toBe("harry");
    expect(admin.headers.get("set-cookie")).toMatch(/HttpOnly/i);

    const stranger = await callback("mallory");
    expect(stranger.status).toBe(403);
    expect(stranger.headers.get("set-cookie") ?? "").not.toContain("windlass_session");

    expect((await callback("harry", "forged", state)).status).toBe(400);
  });

  it("serves the editor, and nothing outside its directory", async () => {
    expect(await (await app.request("/")).text()).toContain("<title>Windlass</title>");
    expect(await (await app.request("/assets/app.js")).text()).toBe("console.log(1)");
    expect((await app.request("/assets/app.js")).headers.get("cache-control")).toContain("immutable");
    // An editor URL, not a file: the page loads and routes it itself.
    expect(await (await app.request("/anything/else")).text()).toContain("<title>Windlass</title>");
    expect(await (await app.request("/..%2Fsecret.html")).text()).not.toBe("nope");
    expect(await (await app.request("/%2e%2e/secret.html")).text()).not.toBe("nope");
  });
});

describe("the runner's door", () => {
  const FLAGGED = `policy: v1
categories:
  flagged_feature:
    evaluators:
      - id: fully_flag_gated
        min_confidence: 0.8
    outcome: merge
`;
  const asRunner = { authorization: `Bearer ${RUNNER_TOKEN}`, "content-type": "application/json" };
  let app: ReturnType<typeof build>;
  beforeEach(() => {
    app = build(loadConfig({ ...appEnv, WINDLASS_RUNNER_TOKEN: RUNNER_TOKEN }));
  });
  const claim = (headers: Record<string, string>) =>
    app.request("/runner/v1/claim", { method: "POST", body: JSON.stringify({ models: ["m"], wait: 0 }), headers });

  it("opens only to the runner token, and a runner gets nowhere else", async () => {
    expect((await claim({ "content-type": "application/json" })).status).toBe(401);
    expect((await claim({ ...asRunner, authorization: `Bearer ${"x".repeat(40)}` })).status).toBe(401);
    expect((await claim(asRunner)).status).toBe(204);
    expect((await app.request("/api/repos", { headers: asRunner })).status).toBe(401);
    expect((await app.request("/runner/v1/anything", { headers: asRunner })).status).toBe(404);
  });

  it("is shut when no runner token is configured", async () => {
    const closed = build(loadConfig(appEnv));
    const response = await closed.request("/runner/v1/claim", { method: "POST", body: "{}", headers: asRunner });
    expect(response.status).toBe(404);
  });

  it("queues questions from the editor, hands them to the runner and takes its answers", async () => {
    const repo = store.getRepo("acme", "app")!;
    store.setPolicySource(repo.id, FLAGGED);
    store.savePull({
      repoId: repo.id,
      number: 1,
      title: "PR 1",
      author: "agent",
      state: "open",
      headSha: "h",
      input: {
        baseSha: "b",
        headSha: "h",
        body: "```windlass\ncategory: flagged_feature\nflag: clip_search\n```",
        diff: ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
      },
      decision: null,
      updatedAt: new Date(0).toISOString(),
    });
    const post = (path: string, body: unknown) =>
      app.request(path, { method: "POST", body: JSON.stringify(body), headers: { ...signedIn, ...json } });

    expect((await post("/api/repos/acme/app/evaluate", { policy: null })).status).toBe(409); // no runner yet
    await claim(asRunner);
    expect(await (await post("/api/repos/acme/app/evaluate", { policy: null })).json()).toEqual({ queued: 1 });

    const { job } = (await (await claim(asRunner)).json()) as { job: { id: string; user: string } };
    expect(job.user).toContain("clip_search");
    const answer = (id: string, body: unknown, headers: Record<string, string> = asRunner) =>
      app.request(`/runner/v1/jobs/${id}`, { method: "POST", body: JSON.stringify(body), headers });
    const output = { verdict: "pass", confidence: 0.9, evidence: [] };
    expect((await answer("nope", { ok: true, model: "m", output })).status).toBe(409);
    expect(
      (await answer(job.id, { ok: true, model: "m", output }, { "content-type": "application/json" })).status,
    ).toBe(401);
    expect((await answer(job.id, { ok: true, model: "m", output })).status).toBe(200);

    const simulated = (await (await post("/api/repos/acme/app/simulate", { policy: null })).json()) as {
      pulls: { draft: { outcome: string } }[];
      evaluators: unknown;
    };
    expect(simulated.pulls[0]!.draft.outcome).toBe("merge");
    expect(simulated.evaluators).toEqual({ online: true, models: ["m"], queued: 0 });
  });
});

describe("dev mode", () => {
  const app = () => build(loadConfig({ WINDLASS_DEV: "1", WINDLASS_WEB_DIR: webDir }));

  it("needs no sign-in but answers only on localhost", async () => {
    expect((await app().request("http://localhost:8080/api/repos")).status).toBe(200);
    expect((await app().request("http://windlass.example/api/repos")).status).toBe(403);
  });

  it("has no webhook or sign-in routes, and takes changes only from a local page", async () => {
    expect((await app().request("http://localhost/auth/login")).headers.get("location")).toBeNull();
    const post = (origin: string) =>
      app().request("http://localhost/api/repos/acme/app/simulate", {
        method: "POST",
        body: JSON.stringify({ policy: null }),
        headers: { "content-type": "application/json", origin },
      });
    expect((await post("http://localhost:5173")).status).toBe(200);
    expect((await post("https://evil.example")).status).toBe(403);
  });
});
