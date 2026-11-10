// The HTTP face of the MCP server. It wraps the stateless `createMcpHandler` from `agents` so that
// every request on `/mcp` gets a fresh server built with the Worker bindings and the caller's
// props. Bearer mode in `src/auth/bearer.ts` builds its own handler with fixed props.
// @starter:access
// Cloudflare Access sign-in in `src/auth/access.ts` builds one per request with the props of the
// person that Access verified.
// @starter:end
// @starter:oauth
// The OAuth provider calls `mcpApiHandler` after it validates the access token.
// @starter:end
import { createMcpHandler, getMcpAuthContext, type McpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

import type { AuthProps } from "#env.ts";
import { log } from "#lib/log.ts";
import { createServer } from "#mcp/server.ts";

/** The path that serves MCP requests. Requests to any other path get a 404 response. */
export const MCP_ROUTE = "/mcp";

// Props arrive as an untyped record, so they're checked here once instead of in every tool. Extra
// fields are dropped, so anything else in the props reaches tool code only when you add it here.
// `id` is the stable key for per-user data. Keep `accessToken` out of logs and tool results.
// A sign-in mode without token scopes, such as bearer mode, sets `scopes` in its props. Props stored
// before `id` became a string carry a number, which is turned into the same text, so those
// sessions keep working and keep their per-user keys.
// @starter:oauth
//
// With GitHub OAuth, the props come from the grant. `id` is the GitHub account ID as text. `name`
// is always a string, because GitHub's display name can be null and the callback stores the login
// in its place. `accessToken` is the user's GitHub token, for tools that call GitHub as the user.
//
// Grant props must never carry `scopes`. The grant keeps the props it was created with, while each
// token carries the scopes it was issued for, which a token request can narrow.
// @starter:end
const propsSchema = z.object({
  id: z.union([z.string(), z.number().int().transform(String)]),
  login: z.string(),
  name: z.string(),
  scopes: z.array(z.string()).optional(),
  accessToken: z.string().optional(),
});

/**
 * Returns the caller for the current request. Scopes come from `tokenScopes`, the scopes of a
 * validated access token, when there are any, and otherwise from the props, as in bearer mode.
 * `props` defaults to the props of the current MCP request, and tests pass their own.
 */
export function resolveAuthProps(
  tokenScopes: readonly string[] | undefined,
  props: unknown = getMcpAuthContext()?.props,
): AuthProps {
  const parsed = propsSchema.safeParse(props);
  if (!parsed.success) {
    throw new Error("The MCP request has no valid auth props.");
  }
  const { id, login, name, scopes, accessToken } = parsed.data;
  return {
    id,
    login,
    name,
    scopes: [...(tokenScopes ?? scopes ?? [])],
    ...(accessToken !== undefined && { accessToken }),
  };
}

/** Options for `createMcpApiHandler`. */
export type McpApiHandlerOptions = {
  /** Fixed props for every request, such as the owner's props in bearer mode. */
  authContext?: McpAuthContext;
  /**
   * Hostnames that the `Host` header may name. The default accepts `localhost` and the Worker's
   * own `workers.dev` hostname, and checks nothing on any other hostname. Set it to your custom
   * domain so that the check applies there too.
   */
  allowedHostnames?: string[];
  /**
   * Hostnames that a browser `Origin` header may name. The default accepts `localhost` and the
   * Worker's `workers.dev` hostname. Requests without an `Origin`, which non-browser MCP clients
   * send, always pass. Add your custom domain when a browser-based client connects from it.
   * `"*"` turns the check off, for a caller that runs a stricter `Origin` check of its own.
   */
  allowedOriginHostnames?: string[] | "*";
  /**
   * Whether responses carry CORS headers. The default allows every origin to read them. Pass
   * `false` when a browser's cookies can authenticate a request, so no other site can read the
   * responses.
   */
  cors?: boolean;
};

/**
 * Creates a Worker-shaped MCP handler, called as `handler(request, env, ctx)`. Create it once at
 * module scope, because each request already gets its own server from the factory. On a custom
 * domain, pass `allowedHostnames` to the production handler so that the `Host` check applies.
 */
export function createMcpApiHandler(options: McpApiHandlerOptions = {}) {
  return createMcpHandler(
    // The factory receives the MCP request context but not the Worker bindings, so it reads them
    // from `cloudflare:workers` and passes them to the tools explicitly.
    ({ authInfo }) => createServer({ env, props: resolveAuthProps(authInfo?.scopes) }),
    {
      route: MCP_ROUTE,
      ...(options.authContext !== undefined && { authContext: options.authContext }),
      ...(options.allowedHostnames !== undefined && { allowedHostnames: options.allowedHostnames }),
      ...(options.allowedOriginHostnames !== undefined && {
        allowedOriginHostnames: options.allowedOriginHostnames,
      }),
      ...(options.cors === false && { corsOptions: false }),
      // The handler answers a thrown error with a generic JSON-RPC error and reports it here,
      // which is the only place that it surfaces.
      onerror: (error) => log.error("mcp.handler_error", { error }),
    },
  );
}

// @starter:oauth
const handler = createMcpApiHandler();

/**
 * The MCP handler for the OAuth provider's `apiHandler` option. The provider sets `ctx.props` to
 * the grant's props and `ctx.auth` to the token, and the `agents` handler reads both.
 */
export const mcpApiHandler = {
  fetch: (request, workerEnv, ctx) => handler(request, workerEnv, ctx),
} satisfies ExportedHandler<Env>;
// @starter:end
