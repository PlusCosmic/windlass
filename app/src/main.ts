import { serve } from "@hono/node-server";
import { appAccess, tokenAccess } from "./access.js";
import { loadConfig } from "./config.js";
import { seedFixtures } from "./fixtures.js";
import { GitHubApp } from "./github-app.js";
import { createHttpApp } from "./http.js";
import { KeyedQueue } from "./queue.js";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { handleWebhook } from "./webhooks.js";

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const queue = new KeyedQueue((key, error) => {
    log(`could not judge ${key}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  });

  const github = config.mode === "app" ? new GitHubApp(config.github) : null;
  const service = new Service({
    store,
    github: github ? appAccess(github) : tokenAccess(config.mode === "dev" ? config.githubToken : null),
    policyPath: config.policyPath,
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
    const seeded = seedFixtures(store, process.env.WINDLASS_FIXTURES_DIR ?? "test/fixtures");
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
