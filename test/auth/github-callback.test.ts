// Tests for the GitHub callback and the whole flow around it: an MCP client registers, the user
// approves, GitHub signs them in, the client exchanges its code for a token, and the token
// reaches the MCP tools with the user's props. MSW stands in for GitHub.
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createOAuthMcpClient, resultText } from "../helpers/mcp.ts";
import { UNMOCKED_URL, useNetwork } from "../helpers/network.ts";
import {
  approveConsent,
  CLIENT_REDIRECT_URI,
  CookieJar,
  exchangeCode,
  type GitHubCalls,
  githubCallback,
  githubHandlers,
  GITHUB_USER,
  location,
  mintAccessToken,
  ORIGIN,
  pkceChallenge,
  refreshToken,
  useAuthVars,
  workerFetch,
} from "../helpers/oauth.ts";

const network = useNetwork();
const setAllowedLogins = useAuthVars();

const tokenErrorSchema = z.looseObject({ error: z.string() });

// Runs the flow to the callback with GitHub's code and returns the callback response.
async function signIn() {
  const { authorization, github } = await approveConsent();
  const callback = await githubCallback(authorization, {
    code: "test-github-code",
    state: github.searchParams.get("state") ?? "",
  });
  return { authorization, callback };
}

// Runs the whole flow and returns the client's tokens.
async function signInForTokens() {
  const { authorization, callback } = await signIn();
  const tokens = await exchangeCode(authorization, location(callback).searchParams.get("code")!);
  return { authorization, tokens };
}

describe("GET /callback", () => {
  it("completes the flow: code, token, and MCP calls as the GitHub user", async () => {
    const calls: GitHubCalls = {};
    network.use(...githubHandlers(GITHUB_USER, calls));
    const { authorization, github } = await approveConsent();

    const callback = await githubCallback(authorization, {
      code: "test-github-code",
      state: github.searchParams.get("state") ?? "",
    });

    expect(callback.status).toBe(302);
    const redirect = location(callback);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLIENT_REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe(authorization.state);
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();
    // The verifier the Worker sent to GitHub matches the challenge it sent at the start.
    expect(await pkceChallenge(calls.verifier ?? "")).toBe(
      github.searchParams.get("code_challenge"),
    );

    const token = await exchangeCode(authorization, code ?? "");
    expect(token.token_type.toLowerCase()).toBe("bearer");
    expect(token.scope).toBe("profile");

    const client = createOAuthMcpClient(token.access_token);
    const initialized = await client.initialize();
    expect(initialized.serverInfo.name).toBe("cloudflare-starter");

    const echo = await client.callTool("example_echo_message", { message: "hello" });
    expect(echo.structuredContent).toEqual({ message: "hello" });

    const visit = await client.callTool("account_record_visit");
    expect(visit.isError).toBeFalsy();
    expect(visit.structuredContent).toMatchObject({
      login: GITHUB_USER.login,
      name: GITHUB_USER.name,
      scopes: ["profile"],
      // The GitHub token reached the tool through the grant's props.
      hasUpstreamToken: true,
    });
    expect(resultText(visit)).not.toContain("gho_test_token");
  });

  it("mints a token through the helper that later tests reuse", async () => {
    network.use(...githubHandlers());

    const client = createOAuthMcpClient(await mintAccessToken());

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("account_record_visit");
  });

  it("keys per-user state by the GitHub account ID, so a renamed login keeps it", async () => {
    network.use(...githubHandlers(GITHUB_USER));
    const client = createOAuthMcpClient(await mintAccessToken());
    const before = await client.callTool("account_record_visit");

    network.use(...githubHandlers({ ...GITHUB_USER, login: "octocat-renamed" }));
    const renamed = createOAuthMcpClient(await mintAccessToken());
    const after = await renamed.callTool("account_record_visit");

    expect(after.structuredContent).toMatchObject({ login: "octocat-renamed" });
    const visits = Number(before.structuredContent?.visits) + 1;
    expect(after.structuredContent?.visits).toBe(visits);
    expect(await env.OAUTH_KV.get(`user:${GITHUB_USER.id}:visits`)).toBe(String(visits));
  });

  it.each([null, ""])(
    "uses the login as the name when the GitHub display name is %j",
    async (name) => {
      network.use(...githubHandlers({ id: 7, login: "nameless", name }));

      const client = createOAuthMcpClient(await mintAccessToken());

      const visit = await client.callTool("account_record_visit");
      expect(visit.structuredContent).toMatchObject({ login: "nameless", name: "nameless" });
    },
  );

  it("answers 400 for a state that this browser didn't start", async () => {
    network.use(...githubHandlers());
    const { authorization } = await approveConsent();

    const callback = await githubCallback(authorization, {
      code: "test-github-code",
      state: "forged-state",
    });

    expect(callback.status).toBe(400);
    expect(callback.headers.get("Location")).toBeNull();
  });

  it("answers 400 for a valid state from a browser without the binding cookie", async () => {
    network.use(...githubHandlers());
    const { authorization, github } = await approveConsent();

    const callback = await githubCallback(
      { ...authorization, jar: new CookieJar() },
      { code: "test-github-code", state: github.searchParams.get("state") ?? "" },
    );

    expect(callback.status).toBe(400);
    expect(callback.headers.get("Location")).toBeNull();
  });

  it("answers 400 when the callback is replayed", async () => {
    network.use(...githubHandlers());
    const { authorization, github } = await approveConsent();
    // The first callback clears the binding cookie, so the replay sends the cookie as it was.
    const cookie = authorization.jar.header();
    const query = new URLSearchParams({
      code: "test-github-code",
      state: github.searchParams.get("state") ?? "",
    });
    const first = await workerFetch(`/callback?${query}`, { headers: { Cookie: cookie } });
    expect(first.status).toBe(302);

    const replay = await workerFetch(`/callback?${query}`, { headers: { Cookie: cookie } });

    expect(replay.status).toBe(400);
    expect(replay.headers.get("Location")).toBeNull();
  });

  it("answers 400 when state is missing", async () => {
    network.use(...githubHandlers());
    const { authorization } = await approveConsent();

    const callback = await githubCallback(authorization, { code: "test-github-code" });

    expect(callback.status).toBe(400);
    expect(callback.headers.get("Location")).toBeNull();
  });

  it("redirects to the client with access_denied when the user declines on GitHub", async () => {
    const { authorization, github } = await approveConsent();

    const callback = await githubCallback(authorization, {
      error: "access_denied",
      state: github.searchParams.get("state") ?? "",
    });

    expect(callback.status).toBe(302);
    const redirect = location(callback);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(authorization.state);
  });

  it("redirects to the client with server_error when GitHub rejects the code", async () => {
    network.use(...githubHandlers());
    const { authorization, github } = await approveConsent();

    const callback = await githubCallback(authorization, {
      code: "expired-code",
      state: github.searchParams.get("state") ?? "",
    });

    expect(callback.status).toBe(302);
    expect(location(callback).searchParams.get("error")).toBe("server_error");
  });

  it("redirects to the client with server_error when GitHub can't be reached", async () => {
    // No GitHub handlers, so the code exchange fails with a network error.
    const { callback } = await signIn();

    expect(callback.status).toBe(302);
    expect(location(callback).searchParams.get("error")).toBe("server_error");
  });

  it("redirects to the client with server_error when GET /user fails", async () => {
    network.use(...githubHandlers());
    network.use(
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ message: "Server Error" }, { status: 500 }),
      ),
    );

    const { authorization, callback } = await signIn();

    expect(callback.status).toBe(302);
    const redirect = location(callback);
    expect(redirect.searchParams.get("error")).toBe("server_error");
    expect(redirect.searchParams.get("state")).toBe(authorization.state);
  });

  it("redirects to the client with server_error when the token response is malformed", async () => {
    network.use(...githubHandlers());
    network.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "" }),
      ),
    );

    const { callback } = await signIn();

    expect(callback.status).toBe(302);
    expect(location(callback).searchParams.get("error")).toBe("server_error");
  });

  it("redirects to the client with server_error when the user response is malformed", async () => {
    network.use(...githubHandlers());
    network.use(
      http.get("https://api.github.com/user", () => HttpResponse.json({ login: "octocat" })),
    );

    const { callback } = await signIn();

    expect(callback.status).toBe(302);
    expect(location(callback).searchParams.get("error")).toBe("server_error");
  });
});

describe("ALLOWED_GITHUB_LOGINS", () => {
  it("allows a listed login, compared without case", async () => {
    setAllowedLogins(" someone-else , OctoCat ");
    network.use(...githubHandlers());

    const { callback } = await signIn();

    expect(callback.status).toBe(302);
    expect(location(callback).searchParams.get("code")).toBeTruthy();
  });

  it("allows a listed numeric GitHub user ID", async () => {
    setAllowedLogins(`someone-else,${GITHUB_USER.id}`);
    network.use(...githubHandlers());

    const { callback } = await signIn();

    expect(location(callback).searchParams.get("code")).toBeTruthy();
  });

  it("allows every account when it's *", async () => {
    setAllowedLogins("*");
    network.use(...githubHandlers({ id: 99, login: "anyone", name: null }));

    const { callback } = await signIn();

    expect(location(callback).searchParams.get("code")).toBeTruthy();
  });

  it.each(["", "  ", ","])("allows no one when it's %j", async (value) => {
    setAllowedLogins(value);
    network.use(...githubHandlers());

    const { callback } = await signIn();

    expect(location(callback).searchParams.get("error")).toBe("access_denied");
  });

  it("redirects to the client with access_denied for an account that isn't listed", async () => {
    setAllowedLogins("someone-else");
    network.use(...githubHandlers());

    const { authorization, callback } = await signIn();

    expect(callback.status).toBe(302);
    const redirect = location(callback);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLIENT_REDIRECT_URI);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(authorization.state);
    expect(redirect.searchParams.get("code")).toBeNull();
  });

  it("lets a listed account refresh its token", async () => {
    setAllowedLogins("octocat");
    network.use(...githubHandlers());
    const { authorization, tokens } = await signInForTokens();

    const refreshed = await refreshToken(authorization, tokens.refresh_token!);

    expect(refreshed.status).toBe(200);
  });

  it("refuses a refresh with invalid_grant once the account is removed", async () => {
    setAllowedLogins("octocat");
    network.use(...githubHandlers());
    const { authorization, tokens } = await signInForTokens();
    setAllowedLogins("someone-else");

    const refreshed = await refreshToken(authorization, tokens.refresh_token!);

    expect(refreshed.status).toBe(400);
    expect(tokenErrorSchema.parse(await refreshed.json()).error).toBe("invalid_grant");
    // The provider revoked the grant, so restoring the account doesn't bring the grant back.
    setAllowedLogins("octocat");
    const again = await refreshToken(authorization, tokens.refresh_token!);
    expect(again.status).toBe(400);
  });
});

describe("the test network", () => {
  // "Failed to fetch" is the network error that the catch-all handler returns.
  it("fails a request that no handler mocks", async () => {
    await expect(fetch(UNMOCKED_URL)).rejects.toThrow("Failed to fetch");
  });

  it("fails an unmocked request even without the catch-all handler", async () => {
    // In MSW 3, handlers passed to `resetHandlers()` replace the initial ones, so this leaves only
    // a handler for another URL. `useNetwork()` restores the catch-all after the test.
    network.resetHandlers(http.get("https://other.example.com/", () => HttpResponse.json({})));

    // The `error` strategy rejects the request with an error that names the option. Without it,
    // the request would go out to the real network.
    await expect(fetch(UNMOCKED_URL)).rejects.toThrow(/onUnhandledFrame/);
  });
});
