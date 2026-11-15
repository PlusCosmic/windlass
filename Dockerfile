# The Windlass GitHub App: the webhook server and the policy editor it serves. The same image runs the
# evaluator runner (`node server.mjs runner`), as a second container that holds the model credential.

# Stage 1: build the server bundle and the editor. Node runs the build scripts; Bun installs, as in CI.
FROM node:24-slim AS build
RUN npm install --global bun@1.3.13
WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:app && bun run build:web
# The version of the Agent SDK the runner was built against, for the runtime stage to install.
RUN node -p "require('./package.json').devDependencies['@anthropic-ai/claude-agent-sdk']" > agent-sdk-version

# Stage 2: the server is one bundled file. The one thing installed beside it is the Claude Agent SDK,
# which only the runner loads: it ships a native CLI per platform, so it can't be bundled.
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    WINDLASS_DATA_DIR=/data \
    WINDLASS_WEB_DIR=/app/web
WORKDIR /app

COPY --from=build /build/app/dist/server.mjs /build/app/dist/server.mjs.map ./
COPY --from=build /build/web/dist ./web
COPY --from=build /build/agent-sdk-version ./
RUN apk add --no-cache libgcc libstdc++ \
    && npm install --omit=dev --no-audit --no-fund --no-save "@anthropic-ai/claude-agent-sdk@$(cat agent-sdk-version)" \
    && npm cache clean --force \
    && rm agent-sdk-version

# The SQLite database lives in /data; mount a volume there that uid 1000 can write.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--enable-source-maps", "server.mjs"]
