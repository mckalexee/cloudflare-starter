// GitHub as the identity provider. After the user approves a client on the consent page, this
// module sends them to GitHub to sign in, and `GET /callback` finishes the sign-in: it exchanges
// GitHub's code for a token, reads the user, checks `ALLOWED_GITHUB_LOGINS`, and completes the
// MCP client's authorization. The OAuth provider's upstream helpers carry the client's request
// across the GitHub round trip and bind its `state` to the user's browser.
import { authorizationErrorRedirect, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { z } from "zod";

import { isAllowedGitHubAccount } from "#auth/allowlist.ts";
import type { AuthEnv } from "#auth/oauth.ts";
import type { AuthProps } from "#env.ts";
import { UpstreamError } from "#lib/errors.ts";
import { fetchJson } from "#lib/http.ts";
import { log } from "#lib/log.ts";

/** The path GitHub redirects back to. Register `<origin>/callback` as the OAuth app's callback. */
export const CALLBACK_PATH = "/callback";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

// `read:user` reads the profile and grants no write access. Add scopes here when a tool needs to
// do more with the user's token.
const GITHUB_SCOPE = "read:user";

// GitHub's REST API rejects requests without a User-Agent.
const USER_AGENT = "cloudflare-starter";

/** What `beginUpstream()` stores for the callback. It's encrypted in KV and never sent to GitHub. */
type UpstreamData = { verifier: string };

// GitHub answers a failed code exchange with status 200 and an `error` field, so the body decides
// whether the exchange worked.
const tokenResponseSchema = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

// `id` is the stable account ID. `login` can change when the user renames their account.
const userSchema = z.object({
  id: z.number(),
  login: z.string().min(1),
  name: z.string().nullable(),
});

// The `error` query parameter comes from the browser, so anyone can make it arbitrarily long.
const MAX_LOGGED_ERROR_LENGTH = 100;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// PKCE (RFC 7636) with S256, which GitHub supports for OAuth apps. 32 random bytes give a
// 43-character verifier, the shortest length the RFC allows.
async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/**
 * Sends the browser to GitHub to sign in, for an authorization request that the user approved.
 * Call it only after consent: `approveConsent()` returned the request, or `isConsentRemembered()`
 * said yes. `headers` are the cookies that the consent helper returned, and the redirect carries
 * them.
 */
export async function redirectToGitHub(
  c: Context<AuthEnv>,
  request: AuthRequest,
  headers?: Headers,
): Promise<Response> {
  const { verifier, challenge } = await createPkce();
  const data: UpstreamData = { verifier };
  const upstream = await c.env.OAUTH_PROVIDER.beginUpstream(request, {
    data,
    ...(headers !== undefined && { headers }),
  });

  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl(c),
    scope: GITHUB_SCOPE,
    state: upstream.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  upstream.headers.set("Location", url.toString());
  return new Response(null, { status: 302, headers: upstream.headers });
}

function callbackUrl(c: Context<AuthEnv>): string {
  return `${new URL(c.req.url).origin}${CALLBACK_PATH}`;
}

async function exchangeCode(c: Context<AuthEnv>, code: string, verifier: string): Promise<string> {
  const body = await fetchJson(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(c),
      code_verifier: verifier,
    }),
    schema: tokenResponseSchema,
    service: "GitHub",
  });
  if ("error" in body) {
    // The error code, such as `bad_verification_code`, is safe to log. The code itself isn't.
    log.warn("auth.github_exchange_rejected", { error: body.error });
    throw new UpstreamError("GitHub");
  }
  return body.access_token;
}

function fetchUser(accessToken: string) {
  return fetchJson(USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    schema: userSchema,
    service: "GitHub",
  });
}

function redirect(location: string, headers: Headers): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

/**
 * Handles `GET /callback`. It recovers the approved request from `state`, signs the user in with
 * GitHub, and redirects to the MCP client with an authorization code. A `state` that is missing,
 * expired, used, or from another browser throws `AuthorizationError`, which renders a 400 page.
 * Once the request is recovered, every failure redirects to the client with an OAuth error,
 * because the client is waiting on its redirect URI to learn how sign-in ended.
 */
export async function handleGitHubCallback(c: Context<AuthEnv>): Promise<Response> {
  const resumed = await c.env.OAUTH_PROVIDER.finishUpstream<UpstreamData>(c.req.raw);
  const { request, headers } = resumed;

  const code = c.req.query("code");
  if (code === undefined || code === "") {
    // The user declined on GitHub, or GitHub failed. Either way the client gets `access_denied`.
    const error = c.req.query("error") ?? "missing_code";
    log.info("auth.github_declined", { error: error.slice(0, MAX_LOGGED_ERROR_LENGTH) });
    return redirect(authorizationErrorRedirect(request, "access_denied"), headers);
  }

  try {
    return await signIn(c, request, code, resumed.data.verifier, headers);
  } catch (error) {
    if (error instanceof UpstreamError) {
      log.warn("auth.github_failed", {
        upstreamStatus: error.upstreamStatus,
        timedOut: error.timedOut,
      });
      const errorCode = error.timedOut ? "temporarily_unavailable" : "server_error";
      return redirect(
        authorizationErrorRedirect(request, errorCode, "Signing in with GitHub failed."),
        headers,
      );
    }
    // Anything else, such as a GitHub body that fails its schema or a KV failure while the grant
    // is stored. Zod reports where a body failed, not the values in it, so no token is logged.
    log.error("auth.callback_failed", { error });
    return redirect(
      authorizationErrorRedirect(request, "server_error", "Signing in with GitHub failed."),
      headers,
    );
  }
}

// Exchanges the code, reads the user, applies the allowlist, and completes the client's
// authorization. It throws on any failure, and `handleGitHubCallback` turns that into a redirect.
async function signIn(
  c: Context<AuthEnv>,
  request: AuthRequest,
  code: string,
  verifier: string,
  headers: Headers,
): Promise<Response> {
  const accessToken = await exchangeCode(c, code, verifier);
  const user = await fetchUser(accessToken);
  const userId = String(user.id);

  if (!isAllowedGitHubAccount(c.env.ALLOWED_GITHUB_LOGINS, { login: user.login, id: userId })) {
    log.warn("auth.login_not_allowed", { login: user.login, id: user.id });
    return redirect(
      authorizationErrorRedirect(
        request,
        "access_denied",
        "This GitHub account isn't allowed to use this server.",
      ),
      headers,
    );
  }

  // No `scopes` here: the MCP handler reads them from each access token, because a token can
  // carry fewer scopes than the grant. `||` also replaces an empty display name, which would
  // otherwise leave the name blank in tool results.
  const props: Omit<AuthProps, "scopes"> = {
    id: user.id,
    login: user.login,
    name: user.name || user.login,
    accessToken,
  };
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request,
    // The account ID, because a grant must outlive a rename of the login.
    userId,
    metadata: { label: props.name },
    scope: request.scope,
    props,
  });
  log.info("auth.authorized", { login: user.login, id: user.id, clientId: request.clientId });
  return redirect(redirectTo, headers);
}
