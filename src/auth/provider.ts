// The OAuth provider that makes this Worker both the authorization server and the resource server
// for its MCP endpoint. It answers discovery, client registration, and token requests itself,
// checks the access token on `/mcp` before the MCP handler runs, and hands every other request to
// the default handler with its helpers on `env.OAUTH_PROVIDER`.
import {
  GrantType,
  OAuthError,
  OAuthProvider,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

import { isAllowedGitHubAccount } from "#auth/allowlist.ts";
import { SCOPES } from "#env.ts";
import { log } from "#lib/log.ts";
import { MCP_ROUTE, mcpApiHandler } from "#mcp/handler.ts";

/** The handler for every request that isn't an OAuth endpoint or the MCP route. */
export type DefaultHandler = ExportedHandler<Env>;

// A production Worker uses one resource URL, and a Preview uses one per hostname it answers on.
// The limit keeps an unexpected stream of hostnames from growing the cache without bound.
const MAX_CACHED_PROVIDERS = 8;

// The grant props that the refresh check reads. The GitHub callback stores them.
const grantPropsSchema = z.object({ login: z.string() });

// Checks `ALLOWED_GITHUB_LOGINS` again when a client refreshes its token, so that removing an
// account from the list cuts off its existing grants once their access tokens expire. The grant's
// `userId` is the GitHub account ID, and its props carry the login. An account that's no longer
// allowed gets `invalid_grant`, and the provider then revokes the grant and its tokens.
function recheckAllowlist({
  grantType,
  userId,
  props,
  env,
}: TokenExchangeCallbackOptions<Env>): void {
  if (grantType !== GrantType.REFRESH_TOKEN) {
    return;
  }
  const parsed = grantPropsSchema.safeParse(props);
  const login = parsed.success ? parsed.data.login : "";
  if (isAllowedGitHubAccount(env.ALLOWED_GITHUB_LOGINS, { login, id: userId })) {
    return;
  }
  log.warn("auth.refresh_not_allowed", { login, id: userId });
  throw new OAuthError("invalid_grant", {
    description: "This GitHub account isn't allowed to use this server.",
  });
}

/**
 * Creates the provider for one resource URL. The resource is fixed at construction because every
 * token is bound to it. The token lifetimes keep the library defaults: one hour for access tokens
 * and 30 days for refresh tokens.
 */
export function createProvider(
  resource: string,
  defaultHandler: DefaultHandler,
): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: MCP_ROUTE,
    apiHandler: mcpApiHandler,
    defaultHandler,
    // `/authorize` is served by the routes in `src/auth/routes.ts`. The provider only advertises it.
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [...SCOPES],
    resourceMetadata: { resource },
    // Lets clients identify themselves with a metadata document URL instead of registering. It
    // needs the `global_fetch_strictly_public` compatibility flag in `wrangler.jsonc`.
    clientIdMetadataDocumentEnabled: true,
    tokenExchangeCallback: recheckAllowlist,
  });
}

/**
 * Returns a function that gives the provider for a resource URL, creating it on first use.
 * Construction only validates options, but reusing one instance per resource avoids repeating that
 * work on every request.
 */
export function createProviderCache(
  defaultHandler: DefaultHandler,
): (resource: string) => OAuthProvider<Env> {
  const providers = new Map<string, OAuthProvider<Env>>();
  return (resource) => {
    let provider = providers.get(resource);
    if (provider === undefined) {
      if (providers.size >= MAX_CACHED_PROVIDERS) {
        // A `Map` iterates in insertion order, so the first key is the oldest entry.
        const oldest = providers.keys().next();
        if (oldest.done !== true) {
          providers.delete(oldest.value);
        }
      }
      provider = createProvider(resource, defaultHandler);
      providers.set(resource, provider);
    }
    return provider;
  };
}
