// Hono application that serves every request the Worker entry hands it. It owns the plain HTTP
// routes.
// @starter:web
// It passes everything else to the React Router app.
// @starter:end
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
// @starter:web
import { createRequestHandler, RouterContextProvider } from "react-router";
// @starter:end

// @starter:oauth
import { authRoutes } from "#auth/routes.ts";
// @starter:end
// @starter:web
import { type Identity, resolveIdentity } from "#http/access.ts";
// @starter:end
import { handleError } from "#http/errors.ts";
import { logRequests } from "#http/logging.ts";
// @starter:web
import { apiRoutes } from "#http/routes/api.ts";
// @starter:end
import { healthRoutes } from "#http/routes/health.ts";
// @starter:web
import { cloudflareContext, identityResolverContext } from "#web/context.ts";
// @starter:end

// @starter:web
const handleWebRequest = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);
// @starter:end

/** Builds the Hono app with its middleware and routes registered in match order. */
export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use(logRequests);
  // Hono's defaults set no Content-Security-Policy, and this app adds none, so each project sets
  // the policy that fits it.
  // @starter:web
  // A policy must allow the inline scripts that React Router uses for hydration.
  // @starter:end
  app.use(
    secureHeaders({
      // Nothing here is meant to be framed.
      // @starter:oauth
      // The consent page sends `DENY` too, and Hono's `SAMEORIGIN` would overwrite its value.
      // @starter:end
      xFrameOptions: "DENY",
      // `Cross-Origin-Opener-Policy: same-origin` would cut the `window.opener` link between a page
      // and a popup that it opens on another origin.
      // @starter:oauth
      // MCP clients can open the consent page in a popup and wait on it through that link.
      // @starter:end
      crossOriginOpenerPolicy: false,
      // HSTS belongs in the zone's SSL/TLS settings. With `includeSubDomains`, a value sent from
      // this Worker would also bind every other host on the domain.
      strictTransportSecurity: false,
    }),
  );
  app.onError(handleError);

  app.route("/", healthRoutes);
  // @starter:web
  app.route("/api", apiRoutes);
  // @starter:end
  // @starter:oauth
  app.route("/", authRoutes);
  // @starter:end

  // @starter:web
  // The catch-all is registered last so that every Hono route matches before React Router.
  app.all("*", (c) => {
    const ctx = c.executionCtx;
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: c.env, ctx });
    // Resolving an identity can mean fetching Access's signing keys, so it waits until the
    // identity gate asks for it, and a public page never pays for it.
    let identity: Promise<Identity | null> | undefined;
    context.set(identityResolverContext, () => {
      identity ??= resolveIdentity(c.req.raw, c.env, ctx);
      return identity;
    });
    return handleWebRequest(c.req.raw, context);
  });
  // @starter:end

  return app;
}
