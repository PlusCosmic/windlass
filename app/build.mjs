// Bundles the App's server into one file, so its image needs Node and nothing installed.
import { build } from "esbuild";

await build({
  entryPoints: ["app/src/main.ts"],
  outfile: "app/dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "none",
  sourcemap: true,
  // Some bundled dependencies are CommonJS and call require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
