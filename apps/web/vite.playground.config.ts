import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss(), {
    name: "playground-same-origin",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api/playground") && req.headers.origin &&
            req.headers.origin !== `http://${req.headers.host}`) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        next();
      });
    },
  }],
  server: {
    host: "0.0.0.0",
    port: 4310,
    strictPort: true,
    cors: false,
    proxy: { "/api/playground": {
      target: "http://127.0.0.1:4311",
      changeOrigin: true,
      headers: { origin: "http://127.0.0.1:4311" },
    } },
  },
  build: {
    outDir: "playground-dist",
    rollupOptions: { input: fileURLToPath(new URL("./playground.html", import.meta.url)) },
  },
});
