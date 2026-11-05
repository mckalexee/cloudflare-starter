// Tests for the consent page: what `GET /authorize` renders, and how `POST /authorize` handles
// Approve and Deny.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { htmlResponse, sanitizeClientName } from "#auth/consent.ts";

import {
  CLIENT_REDIRECT_URI,
  consentHandle,
  location,
  openConsent,
  ORIGIN,
  submitConsent,
  workerFetch,
} from "../helpers/oauth.ts";

describe("GET /authorize", () => {
  it("renders the consent page with every client value escaped", async () => {
    const { response } = await openConsent('<script>alert("x")</script> Client');

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Client");
    expect(page).toContain(`to use ${env.APP_NAME} as you?`);
    expect(page).toContain("Next, GitHub asks you to sign in.");
    expect(page).toContain("See your GitHub login and name.");
    expect(page).toContain("<strong>unverified</strong>");
    expect(page).toContain("<strong>client.example.com</strong>");
    expect(page).toContain('value="profile" checked');
    expect(page).toContain('name="decision" value="approve"');
    expect(page).toContain('name="decision" value="deny"');
  });

  it("forbids framing and binds the handle to the browser with a cookie", async () => {
    const { response } = await openConsent();

    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-oauth-consent/);
  });

  it("renders a 400 page for an unknown client instead of redirecting", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "unknown-client",
      redirect_uri: CLIENT_REDIRECT_URI,
      state: "abc",
    });

    const response = await workerFetch(`/authorize?${params}`);

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    const page = await response.text();
    expect(page).toContain("Invalid client_id");
    expect(page).toContain("start signing in again");
  });

  it("shows a client name without control or bidirectional override characters", async () => {
    const { response } = await openConsent("Good\u202Emoc.live\u0007 App");

    const page = await response.text();
    expect(page).toContain("<h1>Allow Goodmoc.live App to use");
  });
});

describe("sanitizeClientName", () => {
  it("removes control and bidirectional formatting characters and trims the result", () => {
    expect(sanitizeClientName(" \u2067Pay\u202Ela\u0000\u200Fte\u2069\n ", "id")).toBe("Paylate");
  });

  it("shortens a long name to 80 characters, ending in an ellipsis", () => {
    const name = sanitizeClientName("a".repeat(200), "id");

    expect(name).toBe(`${"a".repeat(79)}\u2026`);
  });

  it("counts an emoji sequence as one character, so it never splits one", () => {
    // A family emoji: three people joined by zero-width joiners, one grapheme cluster.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

    const name = sanitizeClientName(family.repeat(100), "id");

    expect(name).toBe(`${family.repeat(79)}\u2026`);
  });

  it("keeps a name at the limit as it is", () => {
    expect(sanitizeClientName("b".repeat(80), "id")).toBe("b".repeat(80));
  });

  it("returns the fallback when nothing is left", () => {
    expect(sanitizeClientName("\u202E\u0007 ", "client-id")).toBe("client-id");
  });
});

describe("htmlResponse", () => {
  it("forbids caching, sniffing, referrers, and framing", () => {
    const response = htmlResponse("<p>x</p>", 400);

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("keeps a header that the OAuth provider's helper already set", () => {
    const response = htmlResponse("", 200, new Headers({ "Cache-Control": "private" }));

    expect(response.headers.get("Cache-Control")).toBe("private");
  });
});

describe("POST /authorize", () => {
  it("redirects to the client with access_denied when the user denies", async () => {
    const { authorization, response } = await openConsent();

    const denied = await submitConsent(authorization, consentHandle(await response.text()), "deny");

    expect(denied.status).toBe(302);
    const redirect = location(denied);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLIENT_REDIRECT_URI);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(authorization.state);
  });

  it("redirects to the client with access_denied when the user approves no scopes", async () => {
    const { authorization, response } = await openConsent();

    const approved = await submitConsent(
      authorization,
      consentHandle(await response.text()),
      "approve",
      [],
    );

    expect(approved.status).toBe(302);
    const redirect = location(approved);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLIENT_REDIRECT_URI);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("error_description")).toBe("No scopes were approved.");
    expect(redirect.searchParams.get("state")).toBe(authorization.state);
  });

  it("redirects to GitHub with state, the callback, and an S256 challenge when the user approves", async () => {
    const { authorization, response } = await openConsent();

    const approved = await submitConsent(
      authorization,
      consentHandle(await response.text()),
      "approve",
    );

    expect(approved.status).toBe(302);
    const github = location(approved);
    expect(`${github.origin}${github.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(github.searchParams.get("client_id")).toBe("test-client-id");
    expect(github.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(github.searchParams.get("scope")).toBe("read:user");
    expect(github.searchParams.get("state")).toMatch(/^[\w-]{20,}$/);
    expect(github.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(github.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("skips the page and goes straight to GitHub once the client is approved", async () => {
    const { authorization, response, query } = await openConsent();
    await submitConsent(authorization, consentHandle(await response.text()), "approve");

    const again = await workerFetch(`/authorize?${query}`, {
      headers: { Cookie: authorization.jar.header() },
    });

    expect(again.status).toBe(302);
    expect(location(again).origin).toBe("https://github.com");
  });

  it("rejects a form posted without the browser's binding cookie", async () => {
    const { response } = await openConsent();

    const forged = await workerFetch("/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        handle: consentHandle(await response.text()),
        decision: "approve",
      }),
    });

    expect(forged.status).toBe(400);
    expect(forged.headers.get("Location")).toBeNull();
  });
});
