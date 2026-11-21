import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the UI runs on :5173 and proxies /api to the Express API on :3000.
// In production the API serves the built files itself (see apps/server/src/app.ts).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: true } },
  },
});
