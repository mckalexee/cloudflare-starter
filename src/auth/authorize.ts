// The authorization endpoint. `GET /authorize` validates the MCP client's request and shows the
// consent page, and `POST /authorize` records the user's decision. Consent comes before the
// GitHub redirect, because every MCP client reaches GitHub through this server's one OAuth app.
// Asking per client stops one client from reusing the GitHub approval that the user gave another.
import type { Context } from "hono";

import { htmlResponse, renderConsentPage } from "#auth/consent.ts";
import { type AuthEnv, consentMemory, supportedScopes, withOfferedScopes } from "#auth/oauth.ts";
import { redirectToGitHub } from "#auth/upstream/github.ts";

/**
 * Handles `GET /authorize`. An invalid request throws `AuthorizationError`, which redirects to the
 * client when its redirect URI is trusted and renders a 400 page otherwise. A request that a
 * remembered approval covers skips the page and goes straight to GitHub.
 */
export async function showConsent(c: Context<AuthEnv>): Promise<Response> {
  const oauth = c.env.OAUTH_PROVIDER;
  // `parseAuthRequest()` also looks up the client and rejects an unknown client ID or an
  // unregistered redirect URI, so nothing below runs for a client that doesn't exist.
  const request = withOfferedScopes(await oauth.parseAuthRequest(c.req.raw));

  if (await oauth.isConsentRemembered(c.req.raw, request, consentMemory(c.env))) {
    return redirectToGitHub(c, request);
  }

  // `describeConsent()` comes before `beginConsent()`, so a failed client lookup leaves nothing
  // in KV.
  const details = await oauth.describeConsent(request);
  const consent = await oauth.beginConsent(request);
  const page = await renderConsentPage({
    details,
    appName: c.env.APP_NAME,
    scopes: supportedScopes(request.scope),
    handle: consent.handle,
  });
  // These headers set the cookie that binds the handle to this browser and forbid framing.
  return htmlResponse(page, 200, consent.headers);
}

/**
 * Handles `POST /authorize`, the consent form. Deny redirects to the client with
 * `access_denied`, and so does Approve with every scope unchecked. Approve stores the approval in
 * a signed cookie and sends the user to GitHub with only the scopes they left checked. A missing,
 * expired, used, or foreign handle throws `AuthorizationError`, which renders a 400 page.
 */
export async function decideConsent(c: Context<AuthEnv>): Promise<Response> {
  const oauth = c.env.OAUTH_PROVIDER;
  const form = await c.req.formData();
  const handle = form.get("handle");
  const handleValue = typeof handle === "string" ? handle : "";

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(c.req.raw, handleValue);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const scope = supportedScopes(form.getAll("scope").filter((value) => typeof value === "string"));
  if (scope.length === 0) {
    // A grant with no scopes would let the client connect but call no tool that needs one, so
    // the client hears that the user approved nothing.
    const denied = await oauth.denyConsent(c.req.raw, handleValue, {
      description: "No scopes were approved.",
    });
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(c.req.raw, handleValue, {
    scope,
    remember: consentMemory(c.env),
  });
  return redirectToGitHub(c, approved.request, approved.headers);
}
