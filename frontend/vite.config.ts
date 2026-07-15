import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Where local Vite should tunnel `/api`, `/media`, `/ws` to.
//
// Override via the untracked `frontend/.env.local`:
//   FLOWBOARD_API_TARGET=https://flow.runany.dev   # point at VPS
//   FLOWBOARD_API_TARGET=http://localhost:8101     # default (local backend)
//
// IMPORTANT: Vite's built-in dotenv loader exposes variables as
// `import.meta.env.*` for the *browser bundle*, but does NOT inject them
// into `process.env` for the config file. So we use `loadEnv()` here to
// explicitly read .env / .env.local / .env.[mode] / .env.[mode].local from
// the project root, then merge with whatever is already in `process.env`
// (lets the user override per-shell: `FLOWBOARD_API_TARGET=… npm run dev`).
//
// Empty prefix (`""`) loads ALL variables regardless of name — needed
// because FLOWBOARD_* is not VITE_*.
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, __dirname, "");
  const target =
    fileEnv.FLOWBOARD_API_TARGET
    || process.env.FLOWBOARD_API_TARGET
    || "http://localhost:8101";

  // Derive the WebSocket target by swapping the scheme. Required because
  // the Vite proxy's `target` must already include `ws://` or `wss://` for
  // the Upgrade request to land on the right backend protocol (Caddy
  // terminates TLS so the production case is `wss://`).
  const wsTarget = target.replace(/^http/, "ws");

  // Surface the resolved targets so a quick glance at `npm run dev`
  // confirms whether the proxy really points at the VPS or local.
  // process.stderr because stdout is reserved for Vite's output stream.
  process.stderr.write(
    `[flowboard/vite] FLOWBOARD_API_TARGET=${target}\n`
    + `[flowboard/vite] ws proxy target      =${wsTarget}\n`,
  );

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // REST + media — same target; both proxied transparently because
        // the backend mounts `/api/*` and `/media/*` on the same FastAPI
        // app.
        "/api": {
          target,
          changeOrigin: true,
          secure: true,
        },
        "/media": {
          target,
          changeOrigin: true,
          secure: true,
        },
        // WebSocket — same backend, different scheme. `ws: true` tells
        // http-proxy to perform the HTTP→WS upgrade; Vite forwards the
        // resulting streaming frames to `wsTarget`.
        "/ws": {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
          secure: true,
        },
      },
    },
  };
});
