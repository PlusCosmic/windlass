import { serve } from "@hono/node-server";
import { appAccess, tokenAccess } from "./access.js";
import { claudeBackend } from "./claude-backend.js";
import { loadConfig, loadRunnerConfig } from "./config.js";
import { Evaluations, hashRunnerToken } from "./evaluations.js";
import { seedFixtures } from "./fixtures.js";
import { GitHubApp } from "./github-app.js";
import { createHttpApp } from "./http.js";
import { KeyedQueue } from "./queue.js";
import { runRunner } from "./runner.js";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { handleWebhook } from "./webhooks.js";

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

/** The name of the runner whose token comes from the App's own environment. */
const CONFIGURED_RUNNER = "default";

/**
 * `runner`: the evaluator runner, a separate process from the App. It holds the model credential, takes
 * questions from the App and answers them. `runner --check` asks one trivial question and exits, to show
 * that the CLI it depends on starts in this image.
 */
async function runner(): Promise<void> {
  const backend = claudeBackend();
  if (process.argv[3] === "--check") {
    const result = await backend.ask(
      {
        id: "check",
        model: process.env.WINDLASS_RUNNER_MODELS?.split(",")[0]?.trim() || "claude-haiku-5-5",
        system: "Answer with the structured output only.",
        user: "Is 2 + 2 equal to 4?",
        schema: { type: "object", required: ["answer"], properties: { answer: { type: "boolean" } } },
      },
      AbortSignal.timeout(120_000),
    );
    // Signed out still shows the CLI runs, which is what an image build can check.
    const ran = result.ok || result.kind === "unavailable";
    console.log(result.ok ? `ok: ${result.model} answered` : `${result.kind}: ${result.message}`);
    process.exit(ran ? 0 : 1);
  }

  const config = loadRunnerConfig();
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  log(`Windlass runner (${backend.name}: ${config.models.join(", ")}) taking work from ${config.appUrl}`);
  await runRunner({ config, backend, log }, stop.signal);
}

async function main(): Promise<void> {
  if (process.argv[2] === "runner") return runner();

  const config = loadConfig();
  const store = new Store(config.dataDir);

  // The runner's token is in this process's environment only so it can be recognised; a runner
  // that is no longer configured stops being one.
  // Dev mode keeps the queue even without a runner, so the fixtures' stored verdicts show.
  const evaluations = config.runnerToken || config.mode === "dev" ? new Evaluations({ store }) : null;
  if (config.runnerToken) store.upsertRunner(CONFIGURED_RUNNER, hashRunnerToken(config.runnerToken), null);
  else store.removeRunner(CONFIGURED_RUNNER);
  const queue = new KeyedQueue((key, error) => {
    log(`could not judge ${key}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  });

  const github = config.mode === "app" ? new GitHubApp(config.github) : null;
  const service = new Service({
    store,
    github: github ? appAccess(github) : tokenAccess(config.mode === "dev" ? config.githubToken : null),
    policyPath: config.policyPath,
    ...(evaluations && { evaluations }),
    ...(config.mode === "app" && { baseUrl: config.baseUrl }),
  });

  // `import owner/name [limit]`: bring a repo's recent PRs into the store, then exit. Reads only.
  if (process.argv[2] === "import") {
    const [owner, name, ...rest] = (process.argv[3] ?? "").split("/");
    if (!owner || !name || rest.length > 0) throw new Error("usage: import <owner>/<name> [limit]");
    const repo = store.upsertRepo(owner, name);
    const imported = await service.importPulls(repo, Number(process.argv[4] ?? 30));
    log(`imported ${imported} pull request(s) from ${owner}/${name}`);
    store.close();
    return;
  }

  if (config.mode === "dev") {
    const seeded = await seedFixtures(store, process.env.WINDLASS_FIXTURES_DIR ?? "test/fixtures", evaluations);
    log(`dev mode: no sign-in, no webhooks, loopback only (${seeded} fixture PRs loaded)`);
  }

  if (github) {
    // Installations made while Windlass was down sent webhooks nobody received; ask GitHub instead.
    void github
      .listInstallationRepos()
      .then((repos) => {
        for (const repo of repos) store.upsertRepo(repo.owner, repo.name, repo.installationId);
        log(`installed on ${repos.length} repo(s)`);
      })
      .catch((error: unknown) =>
        log(`could not list installations: ${error instanceof Error ? error.message : error}`),
      );
  }

  const app = createHttpApp({
    config,
    store,
    service,
    log,
    ...(evaluations && { evaluations }),
    ...(github && {
      onWebhook: (event: string, payload: unknown) =>
        handleWebhook(
          { store, service, queue, policyPath: config.policyPath, appId: async () => (await github.identity()).id },
          event,
          payload,
        ),
    }),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log(`Windlass (${config.mode}) listening on http://${info.address}:${info.port}`);
    log(
      config.runnerToken
        ? "evaluators: waiting for a runner"
        : "evaluators: no WINDLASS_RUNNER_TOKEN, so none will run",
    );
  });

  const stop = () => {
    server.close();
    void queue.idle().then(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
