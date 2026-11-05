// Worker entry point and composition root, and the only module that wires the areas of `src/`
// together. The Hono app from `src/http` serves the HTTP routes.
// @starter:web
// It hands every request that no route matches to the React Router app.
// @starter:end
// @starter:oauth
// Every request passes through the OAuth provider first. The provider serves the OAuth
// endpoints, guards `/mcp`, and hands everything else to the Hono app.
// @starter:end
// @starter:oauth
import { createProviderCache } from "#auth/provider.ts";
import { resolveResource } from "#auth/resource.ts";
import type { ErrorBody } from "#http/errors.ts";
// @starter:end
import { createApp } from "#http/index.ts";
// @starter:oauth
import { log } from "#lib/log.ts";
// @starter:end

const app = createApp();

const appHandler = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;

// @starter:oauth
const providerFor = createProviderCache(appHandler);

export default {
  fetch: (request, env, ctx) => {
    let resource: string;
    try {
      resource = resolveResource(request, env);
    } catch (error) {
      // A missing resource URL is a configuration error that fails every request the same way.
      // The message names the var to set and holds no secret, so the response carries it.
      log.error("auth.resource_unresolved", { path: new URL(request.url).pathname, error });
      const message = error instanceof Error ? error.message : "The resource URL is missing.";
      const body: ErrorBody = { error: { message } };
      return Response.json(body, { status: 500 });
    }
    // The provider stores its helpers on the `env` it receives, as `env.OAUTH_PROVIDER`, unless
    // that property is already set. The runtime passes the same `env` object to every request, the
    // one that `cloudflare:workers` exports, so without a copy per request the helpers would leak
    // onto that shared object, and a Preview could get helpers bound to another resource's provider.
    return providerFor(resource).fetch(request, { ...env }, ctx);
  },
} satisfies ExportedHandler<Env>;
// @starter:end
