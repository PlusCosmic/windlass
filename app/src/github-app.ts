import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { GitHubAppConfig } from "./config.js";

/** Checks a webhook's `X-Hub-Signature-256` against the body exactly as it arrived. */
export function verifyWebhookSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A JWT that identifies the App itself, good for up to ten minutes. */
export function appJwt(appId: string, privateKey: string, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // Issued a minute ago to allow for clock drift between here and GitHub.
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

/** Who the App is on GitHub. Its check runs and comments are attributed to these. */
export interface AppIdentity {
  id: number;
  slug: string;
  /** The login its comments are posted under. */
  botLogin: string;
}

/** Authenticates as the GitHub App and as its installations. */
export class GitHubApp {
  private identityPromise: Promise<AppIdentity> | null = null;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly config: GitHubAppConfig) {}

  private asApp(): Octokit {
    return new Octokit({ auth: appJwt(this.config.appId, this.config.privateKey) });
  }

  identity(): Promise<AppIdentity> {
    this.identityPromise ??= this.asApp()
      .rest.apps.getAuthenticated()
      .then(({ data }) => {
        if (!data?.slug) throw new Error("GitHub did not say which App these credentials belong to");
        return { id: data.id, slug: data.slug, botLogin: `${data.slug}[bot]` };
      })
      .catch((error: unknown) => {
        this.identityPromise = null;
        throw error;
      });
    return this.identityPromise;
  }

  /** A client that acts as the App in one installation. Tokens last an hour and are reused until close to expiry. */
  async installation(installationId: number): Promise<Octokit> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return new Octokit({ auth: cached.token });

    const { data } = await this.asApp().rest.apps.createInstallationAccessToken({ installation_id: installationId });
    this.tokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return new Octokit({ auth: data.token });
  }

  /** The repositories an installation covers, for when the App starts with installations it hasn't seen. */
  async listInstallationRepos(): Promise<{ installationId: number; owner: string; name: string }[]> {
    const app = this.asApp();
    const installations = await app.paginate(app.rest.apps.listInstallations, { per_page: 100 });
    const repos: { installationId: number; owner: string; name: string }[] = [];
    for (const installation of installations) {
      const octokit = await this.installation(installation.id);
      const listed = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
      for (const repo of listed)
        repos.push({ installationId: installation.id, owner: repo.owner.login, name: repo.name });
    }
    return repos;
  }
}
