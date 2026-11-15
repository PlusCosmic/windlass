# Deploying the Windlass App

The App is one container: a Node server that receives GitHub webhooks, keeps its state in a SQLite file, and serves the policy editor. A second container from the same image, the runner, answers the policy's evaluators (section 5); without it everything else works and evaluator lanes escalate. It deploys like the other apps: merging to `master` builds `ghcr.io/pluscosmic/windlass:sha-<commit>` and opens an image bump PR against `PlusCosmic/infrastructure` (`.github/workflows/publish-image.yml`); merging that PR is what Dokploy deploys.

It runs in shadow mode. It comments, labels and reports a check run; it never merges.

## 1. Register the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App. The public hostname is `windlass.pluscosmic.dev` for now; if it moves, these three URLs and `WINDLASS_BASE_URL` change with it.

| Setting                               | Value                                             |
| ------------------------------------- | ------------------------------------------------- |
| Homepage URL                          | `https://windlass.pluscosmic.dev`                 |
| Callback URL                          | `https://windlass.pluscosmic.dev/auth/callback`   |
| Request user authorization on install | off                                               |
| Webhook URL                           | `https://windlass.pluscosmic.dev/webhooks/github` |
| Webhook secret                        | a long random string (`openssl rand -hex 32`)     |
| Where can it be installed             | Only on this account                              |

Repository permissions:

| Permission      | Access       | Why                                                                                                                                               |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contents        | Read & write | Read the policy from the base branch. Write only to push the branch of a policy PR opened from the editor; it never writes to the default branch. |
| Pull requests   | Read & write | Read PRs and diffs, comment, open policy PRs                                                                                                      |
| Issues          | Read & write | Labels                                                                                                                                            |
| Checks          | Read & write | Read CI, report the Windlass check run                                                                                                            |
| Commit statuses | Read         | CI services that report statuses instead of checks                                                                                                |
| Metadata        | Read         | Required                                                                                                                                          |

Subscribe to events: **Pull request**, **Check suite**, **Status**, **Push**.

Then generate a private key and a client secret, and note the App ID and client ID.

Contents can be left at Read if you'd rather copy the YAML out of the editor than have it open PRs; "Open pull request" then fails with GitHub's refusal and nothing else changes.

## 2. Configuration

Everything is environment variables; the server refuses to start if any is missing, so the editor is never served without a sign-in.

| Variable                  | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `WINDLASS_BASE_URL`       | `https://windlass.pluscosmic.dev`                                                   |
| `WINDLASS_ADMINS`         | GitHub logins allowed to sign in to the editor, comma-separated                     |
| `WINDLASS_SESSION_SECRET` | 32+ random characters (`openssl rand -hex 32`); changing it signs everyone out      |
| `GITHUB_APP_ID`           | the App ID                                                                          |
| `GITHUB_APP_PRIVATE_KEY`  | the private key: base64 of the `.pem` (`base64 -i key.pem`) is the easiest to paste |
| `GITHUB_WEBHOOK_SECRET`   | the webhook secret                                                                  |
| `GITHUB_CLIENT_ID`        | the App's client ID                                                                 |
| `GITHUB_CLIENT_SECRET`    | the App's client secret                                                             |

Optional: `PORT` (8080), `WINDLASS_DATA_DIR` (`/data`), `WINDLASS_POLICY_PATH` (`.windlass/policy.yaml`), and `WINDLASS_RUNNER_TOKEN` to let a runner connect (section 5).

## 3. The compose file

`services/windlass.yml` in `PlusCosmic/infrastructure`. The bump workflow skips until this file is on `main`, so add it by hand once, with the tag of an image that has been published:

```yaml
# Windlass (PlusCosmic/windlass): judges agent-authored PRs in shadow mode and serves the policy editor.
# The image tag is bumped by that repo's publish workflow. State is one SQLite file.
services:
  windlass:
    image: "ghcr.io/pluscosmic/windlass:sha-<commit>"
    container_name: windlass
    expose:
      - "8080"
    environment:
      - WINDLASS_BASE_URL=https://windlass.pluscosmic.dev
      - WINDLASS_ADMINS=PlusCosmic
      - WINDLASS_SESSION_SECRET=${WINDLASS_SESSION_SECRET:?Set WINDLASS_SESSION_SECRET}
      - GITHUB_APP_ID=${GITHUB_APP_ID:?Set GITHUB_APP_ID}
      - GITHUB_APP_PRIVATE_KEY=${GITHUB_APP_PRIVATE_KEY:?Set GITHUB_APP_PRIVATE_KEY (base64 of the .pem)}
      - GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET:?Set GITHUB_WEBHOOK_SECRET}
      - GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID:?Set GITHUB_CLIENT_ID}
      - GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET:?Set GITHUB_CLIENT_SECRET}
    volumes:
      # Owned by uid 1000, which the image runs as.
      - "/media-stack/config/windlass:/data"
    restart: unless-stopped
    networks:
      - media-stack

networks:
  media-stack:
    external: true
    name: dokploy-network
```

In Dokploy, give the service the domain `windlass.pluscosmic.dev` on port 8080, set the six secrets in its Environment tab, and add the same name as a public hostname on the Cloudflare Tunnel like the other Dokploy routes. `/webhooks/github` must be reachable by GitHub, so don't put Cloudflare Access in front of the hostname; the editor has its own sign-in.

The `windlass` repo needs the `INFRASTRUCTURE_PR_TOKEN` secret the other app repos have.

## 4. Install it

Install the App on a repository (App settings → Install App). The repo appears in the editor; "Import recent pull requests" brings its history in to replay.

A repo judged by the App should not also run the Action: remove its `.github/workflows/windlass.yml`, or both will comment and fight over the labels. `ci_green` needs no `ignore` for the App's own check; the App never counts its own check runs.

## 5. The evaluator runner

Evaluators ask a model a question about a PR's diff. Windlass never calls the model itself: the runner does, with a credential only it holds, and it holds nothing of GitHub's. It makes outbound requests only (to the App for questions, and to the model), so it needs no route or volume.

1. Make a token for the runner to sign in to the App with, and give the same value to both services as `WINDLASS_RUNNER_TOKEN` (32+ characters, `openssl rand -hex 32`).
2. Give the runner a model credential. For a Claude subscription, run `claude setup-token` on a machine with a browser and set the token it prints as `CLAUDE_CODE_OAUTH_TOKEN`; it lasts a year. An API key works too, as `ANTHROPIC_API_KEY`.
3. Add the runner to the compose file, and put the App on the stack's own network so the runner can reach it by name:

```yaml
services:
  windlass:
    # ...as above, plus:
    environment:
      - WINDLASS_RUNNER_TOKEN=${WINDLASS_RUNNER_TOKEN:?Set WINDLASS_RUNNER_TOKEN}
    networks:
      - default
      - media-stack

  # Answers the policy's evaluators. Holds the model credential and no GitHub one.
  windlass-runner:
    image: "ghcr.io/pluscosmic/windlass:sha-<commit>"
    container_name: windlass-runner
    command: ["node", "--enable-source-maps", "server.mjs", "runner"]
    environment:
      - WINDLASS_APP_URL=http://windlass:8080
      - WINDLASS_RUNNER_TOKEN=${WINDLASS_RUNNER_TOKEN:?Set WINDLASS_RUNNER_TOKEN}
      - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:?Set CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token)}
    # The image's health check asks the App's HTTP port, which the runner doesn't have.
    healthcheck:
      disable: true
    restart: unless-stopped
    networks:
      - default
```

| Variable                  | Value                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `WINDLASS_APP_URL`        | where the App is; `http://windlass:8080` on the compose network                                            |
| `WINDLASS_RUNNER_TOKEN`   | the same token the App has                                                                                 |
| `CLAUDE_CODE_OAUTH_TOKEN` | a Claude subscription token from `claude setup-token`; or set `ANTHROPIC_API_KEY`                          |
| `WINDLASS_RUNNER_MODELS`  | optional: the models it will run, the default first (`claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5`) |

The runner refuses to start if it is given the App's secrets, and runs a model only if it is in its list, whatever a policy asks for. It works through questions one at a time. On a subscription it shares the plan's usage limits with everything else on that plan: when a limit is hit, evaluators escalate with "the runner could not ask the model" until it resets.

`docker run --rm ghcr.io/pluscosmic/windlass:sha-<commit> node server.mjs runner --check` asks one trivial question and prints the answer, or why there was none.

Anyone else running Windlass would run a runner of their own with their own credential. A subscription's terms don't allow a hosted service to use it on someone else's behalf, which is why the credential lives in the runner and not in the App.

## Running it locally

```sh
bun run build:web
bun run dev:server      # http://127.0.0.1:8080, with the test fixtures as sample PRs
```

Dev mode has no sign-in and no webhooks, listens only on loopback, and never writes to GitHub. To replay a real repo's PRs, import them with a token that can read it:

```sh
GITHUB_TOKEN=$(gh auth token) WINDLASS_DEV=1 node app/dist/server.mjs import PlusCosmic/reelshelf 40
```

To have evaluators answered locally, give the dev server a runner token and start a runner beside it. With no `CLAUDE_CODE_OAUTH_TOKEN` set it uses this machine's own Claude Code sign-in:

```sh
export WINDLASS_RUNNER_TOKEN=$(openssl rand -hex 32)
WINDLASS_DEV=1 node app/dist/server.mjs &
WINDLASS_APP_URL=http://127.0.0.1:8080 node app/dist/server.mjs runner
```

While working on the editor itself, `bun run dev:web` serves it with hot reload and proxies the API to the server above.
