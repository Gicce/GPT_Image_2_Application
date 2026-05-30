import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("recharts")) return "charts-vendor";
            if (id.includes("highlight.js")) return "highlight-vendor";
            if (id.includes("marked")) return "markdown-vendor";
            if (id.includes("@tauri-apps")) return "tauri-vendor";
            if (id.includes("qrcode")) return "qrcode-vendor";
            return "shared-vendor";
          }

          if (id.includes("/src/pages/")) {
            if (id.includes("/Chat") || id.includes("/AgentChat")) return "page-chat";
            if (id.includes("/Settings")) return "page-settings";
            if (id.includes("/Account")) return "page-account";
          }
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
