import { Octokit } from "@octokit/rest";
import type { GitHubApp } from "./github-app.js";
import { AppOctokitPort } from "./port.js";
import type { GitHubAccess } from "./service.js";

/** Reaches repos as the GitHub App, through whichever installation covers each one. */
export function appAccess(app: GitHubApp): GitHubAccess {
  return {
    async forRepo(repo) {
      if (repo.installationId === null) return null;
      const [octokit, identity] = await Promise.all([app.installation(repo.installationId), app.identity()]);
      const port = new AppOctokitPort(octokit, {
        owner: repo.owner,
        repo: repo.name,
        // Windlass must never wait on, or be failed by, its own check run.
        ignoreApps: [identity.slug],
        commentAuthor: identity.botLogin,
      });
      return { port, write: true };
    },
  };
}

/** Dev mode: reads repos with a personal token, and never writes. Without a token it reaches nothing. */
export function tokenAccess(token: string | null): GitHubAccess {
  return {
    async forRepo(repo) {
      if (token === null) return null;
      const port = new AppOctokitPort(new Octokit({ auth: token }), {
        owner: repo.owner,
        repo: repo.name,
        commentAuthor: "",
      });
      return { port, write: false };
    },
  };
}
