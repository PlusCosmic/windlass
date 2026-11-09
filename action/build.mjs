// Bundles the Action into one committed file, as JavaScript Actions run without installing dependencies.
import { build } from "esbuild";

await build({
  entryPoints: ["action/src/main.ts"],
  outfile: "action/dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "none",
  // Some bundled dependencies are CommonJS and call require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
