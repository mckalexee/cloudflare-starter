// The pages that the auth routes render: the consent page and a plain message page for errors.
// They use `hono/html`, which escapes every interpolated value. That matters here, because the
// client name, the redirect host, and the scopes come from dynamic registration or a client
// metadata document, so whoever registers a client chooses them.
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { html } from "hono/html";

import { SCOPE_DESCRIPTIONS, type Scope } from "#env.ts";

// Long enough for any real app name, short enough that a name can't push the rest of the page
// out of view.
const MAX_CLIENT_NAME_LENGTH = 80;

// Control characters, and the Unicode bidirectional formatting characters: the marks, embeddings,
// overrides, and isolates. An override can make a name render as different text from what it
// contains, such as a reversed domain.
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

// Headers for every page these routes render. The consent page carries a single-use handle, so no
// cache may keep it and no other site may frame it or learn its URL. `htmlResponse` adds each one
// only when the OAuth provider's helper hasn't set it already.
const PAGE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

const STYLE = html`<style>
  body {
    font:
      16px/1.5 system-ui,
      sans-serif;
    max-width: 32rem;
    margin: 3rem auto;
    padding: 0 1rem;
  }
  .warning {
    padding: 0.5rem 0.75rem;
    border-left: 4px solid #b45309;
    background: #fef3c7;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  button {
    font: inherit;
    padding: 0.4rem 1rem;
    margin-right: 0.5rem;
  }
</style>`;

/**
 * Returns a client name that is safe to show as plain text. It removes control characters and
 * bidirectional formatting characters, trims the result, and shortens it to 80 characters, ending
 * in an ellipsis when it cuts. Whoever registers a client chooses its name, so the page must not
 * let the name disguise itself or crowd out the warnings. It returns `fallback` when nothing is
 * left.
 */
export function sanitizeClientName(name: string, fallback: string): string {
  const cleaned = name.replaceAll(UNSAFE_NAME_CHARACTERS, "").trim();
  // Counting grapheme clusters keeps an emoji or a letter with its accent in one piece.
  const characters = Array.from(GRAPHEMES.segment(cleaned), ({ segment }) => segment);
  if (characters.length === 0) {
    return fallback;
  }
  if (characters.length <= MAX_CLIENT_NAME_LENGTH) {
    return cleaned;
  }
  // One character less leaves room for the ellipsis within the limit.
  const kept = characters
    .slice(0, MAX_CLIENT_NAME_LENGTH - 1)
    .join("")
    .trimEnd();
  return `${kept}\u2026`;
}

/** What the consent page shows: the facts from `describeConsent()` and the scopes to offer. */
export interface ConsentPageInput {
  details: ConsentDescription;
  /** This server's name from `APP_NAME`, which the heading asks the user to share. */
  appName: string;
  scopes: readonly Scope[];
  /** The handle from `beginConsent()`, which the form posts back. */
  handle: string;
}

/**
 * Renders the consent page. It names the client, says whether its domain is verified, shows where
 * the tokens will go, and lists each scope as a checked box. The form posts the handle and the
 * user's decision to `POST /authorize`.
 */
export async function renderConsentPage({ details, appName, scopes, handle }: ConsentPageInput) {
  // The provider issued or validated the client ID, so it can stand in for a name with nothing left.
  const clientName = sanitizeClientName(details.clientName, details.clientId);
  const origin =
    details.clientDomain === undefined
      ? html`<p>
          Publisher: <strong>unverified</strong>. This app registered itself, so its name isn't
          verified.
        </p>`
      : html`<p>Publisher: <strong>${details.clientDomain}</strong> (verified domain).</p>`;
  const loopback = details.redirectIsLoopback
    ? html`<p class="warning">
        This sends access to an app on your computer. Continue only if you just started signing in
        from it.
      </p>`
    : "";
  const page = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Authorize ${clientName}</title>
        ${STYLE}
      </head>
      <body>
        <h1>Allow ${clientName} to use ${appName} as you?</h1>
        <p>Next, GitHub asks you to sign in.</p>
        ${origin}
        <p>Access will be sent to <strong>${details.redirectHost}</strong>.</p>
        ${loopback}
        <form method="post" action="/authorize">
          <input type="hidden" name="handle" value="${handle}" />
          <p>${clientName} will be able to:</p>
          <ul>
            ${scopes.map(
              (scope) =>
                html`<li>
                  <label>
                    <input type="checkbox" name="scope" value="${scope}" checked />
                    <code>${scope}</code>: ${SCOPE_DESCRIPTIONS[scope]}
                  </label>
                </li>`,
            )}
          </ul>
          <p>
            <button type="submit" name="decision" value="approve">Approve</button>
            <button type="submit" name="decision" value="deny">Deny</button>
          </p>
        </form>
      </body>
    </html>`;
  return (await page).toString();
}

/**
 * Renders a page for an error that can't go back to the client: a heading, what went wrong, and
 * what the user can do next.
 */
export async function renderMessagePage(title: string, message: string, nextStep: string) {
  const page = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        ${STYLE}
      </head>
      <body>
        <h1>${title}</h1>
        <p>${message}</p>
        <p>${nextStep}</p>
      </body>
    </html>`;
  return (await page).toString();
}

/**
 * Builds an HTML response from a rendered page, keeping any headers that a helper returned. It
 * forbids caching, MIME sniffing, referrers, and framing, unless the helper's headers already say
 * otherwise.
 */
export function htmlResponse(body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  for (const [name, value] of Object.entries(PAGE_HEADERS)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return new Response(body, { status, headers });
}
