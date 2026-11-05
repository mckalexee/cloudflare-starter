// The browser-facing OAuth routes: the consent page and the GitHub callback. The Hono app mounts
// them before its catch-all. The OAuth provider serves the rest of the OAuth surface itself:
// discovery, client registration, and the token endpoint.
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";

import { decideConsent, showConsent } from "#auth/authorize.ts";
import { htmlResponse, renderMessagePage } from "#auth/consent.ts";
import type { AuthEnv } from "#auth/oauth.ts";
import { CALLBACK_PATH, handleGitHubCallback } from "#auth/upstream/github.ts";
import { handleError } from "#http/errors.ts";
import { log } from "#lib/log.ts";

/**
 * Routes for `GET /authorize`, `POST /authorize`, and `GET /callback`. Mount them with
 * `app.route("/", authRoutes)`. They read the provider's helpers from `c.env.OAUTH_PROVIDER`, so
 * they work only in a request that came through the OAuth provider in `src/worker.ts`.
 */
export const authRoutes = new Hono<AuthEnv>()
  .get("/authorize", showConsent)
  .post("/authorize", decideConsent)
  .get(CALLBACK_PATH, handleGitHubCallback)
  .onError(async (error, c) => {
    // A validated client and redirect URI make a redirect safe, and the client then learns why
    // the authorization failed. Anything else is shown to the user, never sent to an unchecked
    // redirect URI.
    if (error instanceof AuthorizationError) {
      if (error.redirectTo !== undefined) {
        return c.redirect(error.redirectTo, 302);
      }
      log.info("auth.request_rejected", { path: c.req.path, error: error.code });
      const page = await renderMessagePage(
        "Sign-in failed",
        error.description,
        "Go back to the app you were connecting, and start signing in again from there.",
      );
      return htmlResponse(page, 400);
    }
    if (error instanceof CimdFetchError) {
      log.warn("auth.client_metadata_failed", { path: c.req.path, reason: error.reason });
      const page = await renderMessagePage(
        "Sign-in failed",
        "This server couldn't load the app's registration details, so it can't confirm which " +
          "app is asking for access.",
        "Try again in a few minutes. If it keeps failing, contact the app's developer.",
      );
      return htmlResponse(page, 400);
    }
    return handleError(error, c);
  });
