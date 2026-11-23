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
  // The port is fixed and is this project's own. A second project that answered on the same port
  // would receive this project's cookies and saved URLs, so the dev server stops when the port is
  // taken instead of moving to the next one. `pnpm dev --port <n>` runs a second copy.
  // @starter:mcp
  // MCP clients save the endpoint's URL with the port in it.
  // @starter:end
  // @starter:oauth
  // OAuth tokens are bound to the local `MCP_RESOURCE` URL, and the GitHub OAuth app's callback URL
  // names the port.
  // @starter:end
  server: { port: 5173, strictPort: true },
});
