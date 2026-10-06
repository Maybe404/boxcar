import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The runtime of the MyGo version in go.mod, vendored: npm lags behind.
    alias: { "mygo-runtime": fileURLToPath(new URL("./vendor/mygo-runtime/index.ts", import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/dist/**"] },
  },
  build: { target: "safari17", chunkSizeWarningLimit: 1200 },
});
