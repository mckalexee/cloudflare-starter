// Test runner configuration. Tests run inside workerd through the Cloudflare plugin, so they use
// the same bindings and runtime APIs as the deployed Worker.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
// @starter:web
import { reactRouter } from "@react-router/dev/vite";
// @starter:end
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";

const WRANGLER_CONFIG = "./wrangler.jsonc";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// The plugin reads the vars and secrets from `.dev.vars`, or from `.env` files and the process
// environment, over the values in `wrangler.jsonc`, and it has no option to turn that off. The
// bindings below set every var and required secret to a fixed value, so test results never
// depend on those local files. Wrangler doesn't publish the type of its config, so TypeScript
// sees `any` here, and the annotation names the fields that this file reads.
const { vars, secrets }: { vars: Record<string, Json>; secrets?: { required?: string[] } } =
  unstable_readConfig({ config: WRANGLER_CONFIG });

// Fixed values for the secrets in `secrets.required`. A required secret without a value here is
// empty in tests, the same as a secret that isn't set.
const TEST_SECRETS: Record<string, string> = Object.fromEntries(
  (secrets?.required ?? []).map((key) => [key, ""]),
);
// @starter:oauth
Object.assign(TEST_SECRETS, {
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  // Remembered consent needs a secret of at least 32 characters. This is 64 hex digits, the same
  // shape that `openssl rand -hex 32` gives for `.dev.vars`.
  COOKIE_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});
// @starter:end

// Wrangler warns about each required secret that it can't find in `.dev.vars`, `.env`, or the
// process environment, once per test file. The bindings below already supply the values, so
// copying them into the process environment only silences that warning.
for (const [key, value] of Object.entries(TEST_SECRETS)) {
  process.env[key] ??= value;
}

export default defineConfig({
  plugins: [
    // @starter:web
    // Resolves `virtual:react-router/server-build`, so tests reach the real Worker entry.
    reactRouter(),
    // @starter:end
    cloudflareTest({
      wrangler: { configPath: WRANGLER_CONFIG },
      miniflare: {
        bindings: {
          ...vars,
          ...TEST_SECRETS,
          // @starter:oauth
          // The resource URL matches the origin that tests send requests to.
          MCP_RESOURCE: "http://localhost:5173/mcp",
          // @starter:end
        },
      },
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
