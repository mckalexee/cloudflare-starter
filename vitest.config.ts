// Test runner configuration. Tests run inside workerd through the Cloudflare plugin, so they use
// the same bindings and runtime APIs as the deployed Worker.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
// @starter:web
import { reactRouter } from "@react-router/dev/vite";
// @starter:end
import { defineConfig } from "vitest/config";

// @starter:oauth
// Fixed values for the secrets in `secrets.required`, so tests never depend on a local
// `.dev.vars` file.
const TEST_SECRETS = {
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  // Remembered consent needs a secret of at least 32 characters. This is 64 hex digits, the same
  // shape that `openssl rand -hex 32` gives for `.dev.vars`.
  COOKIE_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

// Wrangler warns about each required secret that it can't find in `.dev.vars`, `.env`, or the
// process environment, once per test file. The bindings below already supply the values, so
// copying them into the process environment only silences that warning.
for (const [key, value] of Object.entries(TEST_SECRETS)) {
  process.env[key] ??= value;
}
// @starter:end

export default defineConfig({
  plugins: [
    // @starter:web
    // Resolves `virtual:react-router/server-build`, so tests reach the real Worker entry.
    reactRouter(),
    // @starter:end
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // @starter:oauth
      // The resource URL matches the origin that tests send requests to.
      miniflare: { bindings: { MCP_RESOURCE: "http://localhost:5173/mcp", ...TEST_SECRETS } },
      // @starter:end
    }),
  ],
  // @starter:web
  // The React Router plugin sets its own resolve conditions for the `ssr` environment, which
  // drops the Workers conditions. These match the Cloudflare Vite plugin's production build, so
  // packages such as `@msw/cloudflare` load their Workers entry instead of their Node entry.
  environments: {
    ssr: { resolve: { conditions: ["workerd", "worker", "module", "browser"] } },
  },
  // @starter:end
  test: {
    // The first request in a test file loads the Worker and its dependencies, which can take
    // longer than the default five seconds on a busy machine.
    testTimeout: 15_000,
    coverage: { provider: "istanbul", include: ["src/**"] },
  },
});
