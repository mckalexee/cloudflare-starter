// Shared types and policy for the auth routes: the Hono environment they run in, the scopes the
// consent page offers, and how approvals are remembered.
import type {
  AuthRequest,
  OAuthHelpers,
  RememberConsentOptions,
} from "@cloudflare/workers-oauth-provider";

import { SCOPES, type Scope } from "#env.ts";

/**
 * The bindings that auth routes see. The OAuth provider adds `OAUTH_PROVIDER` to the `env` it
 * passes to its default handler, so it exists only on `c.env` in a request that came through the
 * provider, never on the `env` that `cloudflare:workers` exports.
 */
export type AuthBindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** The Hono environment for auth routes. */
export type AuthEnv = { Bindings: AuthBindings };

function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/**
 * Returns the request with the scopes that the consent page offers: the requested scopes that this
 * server supports. A client that requests none, or only unsupported ones, is offered every scope,
 * because MCP clients often send no `scope` parameter at all.
 */
export function withOfferedScopes(request: AuthRequest): AuthRequest {
  const supported = request.scope.filter(isScope);
  return { ...request, scope: supported.length > 0 ? [...new Set(supported)] : [...SCOPES] };
}

/** Keeps only the values that are scopes this server supports, such as the scopes a form posted. */
export function supportedScopes(values: readonly string[]): Scope[] {
  return [...new Set(values.filter(isScope))];
}

// A week balances fewer consent prompts against how long a browser keeps an approval that the
// user may have forgotten giving. The library's default is 30 days.
const CONSENT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * The options for remembering consent. Approvals are kept for 7 days in a cookie signed with
 * `COOKIE_SECRET` and bound to the client, its redirect URI, and the resource. The provider
 * rejects a secret shorter than 32 characters. There's no `subject`, because this server learns
 * who the user is from GitHub only after consent, so an approval belongs to the browser.
 */
export function consentMemory(env: Env): RememberConsentOptions {
  return { secret: env.COOKIE_SECRET, maxAgeSeconds: CONSENT_MAX_AGE_SECONDS };
}
