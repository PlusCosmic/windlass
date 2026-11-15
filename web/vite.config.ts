import { appearance } from "@pluscosmic/ui/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The storage key must match AppearanceProvider's in src/main.tsx.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), appearance({ storageKey: "windlass" })],
  server: {
    // `bun run dev:server` serves the API; the page is served from here while developing.
    proxy: { "/api": "http://127.0.0.1:8080", "/auth": "http://127.0.0.1:8080" },
  },
});
