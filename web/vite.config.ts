import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app talks to the local Express server (server/) over /api.
// Vite proxies those calls in dev so the browser hits a single origin.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@xyflow") || id.includes("node_modules/@dagrejs")) {
            return "dag-vendor";
          }
          if (id.includes("node_modules/radix-ui") || id.includes("node_modules/@radix-ui")) {
            return "radix-vendor";
          }
          if (id.includes("node_modules/lucide-react")) {
            return "icons-vendor";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    headers: {
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
