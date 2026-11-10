// Cloudflare Access sign-in for the MCP endpoint. Access is the authorization server, through its
// Managed OAuth feature: MCP clients sign in with Access, and Access forwards each request with a
// signed `Cf-Access-Jwt-Assertion` header. These routes verify that identity, serve MCP as that
// person, and publish the protected resource metadata that names Access as the authorization
// server. The Worker holds no sign-in flow and no secrets in this mode.
import { type Context, Hono } from "hono";

import { type AuthProps, SCOPES } from "#env.ts";
import { accessConfig, type Identity, resolveIdentity } from "#http/access.ts";
import { type ErrorBody, handleError } from "#http/errors.ts";
import { HttpError } from "#lib/errors.ts";
import { log } from "#lib/log.ts";
import { createMcpApiHandler, MCP_ROUTE } from "#mcp/handler.ts";

/** The path of the protected resource metadata (RFC 9728) without the resource's path suffix. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

type AccessRoutesEnv = { Bindings: Env };

/**
 * Returns the MCP caller for an Access identity. The lowercase email is both `id` and `login`, so
 * one person keeps one set of per-user data whatever case a login method reports the address in.
 * The Access policy already decided who may connect, so the caller gets every scope.
 */
export function accessProps(identity: Identity): AuthProps {
  const email = identity.email.toLowerCase();
  return { id: email, login: email, name: identity.name ?? email, scopes: [...SCOPES] };
}

// Access can also authenticate a browser with its session cookie, and then the Worker sees the
// same signed header as for an MCP client's token. So a page on another origin, even a sibling
// subdomain that counts as the same site, must not reach `/mcp` with a signed-in person's cookie.
// MCP clients that run outside a browser send neither header.
function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return true;
  }
  const site = request.headers.get("Sec-Fetch-Site");
  return site !== null && site !== "same-origin" && site !== "none";
}

let warnedUnconfigured = false;

// The Worker's own 401 means that no Access identity arrived: on a Preview, which Access doesn't
// cover, or on a deployment whose Access application is missing. In production, Access answers an
// unauthenticated request before the Worker runs, with its own challenge.
function unauthorized(c: Context<AccessRoutesEnv>): Response {
  const body: ErrorBody = {
    error: { message: "This endpoint requires a Cloudflare Access identity." },
  };
  return c.json(body, 401, { "WWW-Authenticate": "Bearer" });
}

// Access serves these documents itself when its application covers the whole hostname. When the
// application covers only `/mcp`, the requests reach the Worker, and MCP clients need them to find
// Access as the authorization server.
function protectedResourceMetadata(c: Context<AccessRoutesEnv>): Response {
  const config = accessConfig(c.env);
  if (config === null) {
    throw new HttpError(404, "Cloudflare Access sign-in isn't configured.");
  }
  return c.json({
    resource: `${new URL(c.req.url).origin}${MCP_ROUTE}`,
    authorization_servers: [`https://${config.teamDomain}`],
    bearer_methods_supported: ["header"],
  });
}

/**
 * Routes for `/mcp` and both forms of the protected resource metadata URL. Mount them with
 * `app.route("/", accessRoutes)`. `/mcp` answers 403 to a cross-origin browser request, 401
 * without an Access identity, and serves MCP as the identity otherwise. With empty Access vars,
 * `/mcp` answers 401 and the metadata 404, so a Worker without its Access settings fails closed.
 */
export const accessRoutes = new Hono<AccessRoutesEnv>()
  .get(PROTECTED_RESOURCE_PATH, protectedResourceMetadata)
  .get(`${PROTECTED_RESOURCE_PATH}${MCP_ROUTE}`, protectedResourceMetadata)
  .all(MCP_ROUTE, async (c) => {
    if (isCrossOrigin(c.req.raw)) {
      throw new HttpError(403, "Cross-origin requests to the MCP endpoint aren't allowed.");
    }
    if (accessConfig(c.env) === null) {
      // Every request fails the same way until the vars are set, so one line per isolate is
      // enough to find the cause.
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        log.error("auth.access_unconfigured");
      }
      return unauthorized(c);
    }
    const identity = await resolveIdentity(c.req.raw, c.env, c.executionCtx);
    if (identity === null) {
      return unauthorized(c);
    }
    // The handler carries fixed props, so each request gets its own with the caller's props. The
    // `Origin` check above is stricter than the handler's own, and no CORS headers go out, so no
    // other site can read a response.
    const mcp = createMcpApiHandler({
      authContext: { props: accessProps(identity) },
      allowedOriginHostnames: "*",
      cors: false,
    });
    return mcp.fetch(c.req.raw);
  })
  .onError(handleError);
