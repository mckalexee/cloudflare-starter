// Vite build for the Worker. The Cloudflare plugin runs the server build in workerd.
// @starter:web
// It must come before the React Router plugin so the two share the `ssr` environment.
// @starter:end
import { cloudflare } from "@cloudflare/vite-plugin";
// @starter:web
import { reactRouter } from "@react-router/dev/vite";
// @starter:end
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
    }),
    // @starter:web
    reactRouter(),
    // @starter:end
  ],
  // @starter:oauth
  // A fixed port keeps the local `MCP_RESOURCE` URL valid, because OAuth tokens are bound to it.
  // @starter:end
  server: { port: 5173, strictPort: true },
});
