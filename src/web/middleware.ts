// React Router middleware for routes that need a signed-in person. It applies the same rule as
// `requireIdentity()` in the Hono layer, so the web app and the API agree on who gets in.
import { data, type MiddlewareFunction } from "react-router";

import { identityRequired } from "#http/access.ts";
import { cloudflareContext, identityContext, identityResolverContext } from "#web/context.ts";

/**
 * Resolves the identity of the request and stores it in `identityContext`. On a private site, it
 * rejects a request without an identity with a 403 response. On a public site, every request
 * passes. The root route runs it for every route that isn't public.
 */
export const requireIdentityMiddleware: MiddlewareFunction<Response> = async ({ context }) => {
  const { env } = context.get(cloudflareContext);
  const required = identityRequired(env);
  const identity = await context.get(identityResolverContext)();
  context.set(identityContext, identity);
  if (identity === null && required) {
    // Without `statusText`, React Router reports the 403 as "Internal Server Error".
    throw data(
      { message: "This page requires a Cloudflare Access identity." },
      { status: 403, statusText: "Forbidden" },
    );
  }
};
