// Drives the real OAuth flow through the Worker entry, the way an MCP client and a browser would:
// dynamic registration, the consent page, the GitHub round trip, and the token exchange. GitHub
// itself is replaced by MSW handlers, so no test reaches the network.
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpHandler } from "msw";
import { afterEach, beforeEach } from "vitest";
import { z } from "zod";

/** The origin of every test request. It matches `MCP_RESOURCE` in `vitest.config.ts`. */
export const ORIGIN = "http://localhost:5173";

/** The resource URL that tokens are bound to in tests. */
export const RESOURCE = `${ORIGIN}/mcp`;

/** The redirect URI that test clients register. */
export const CLIENT_REDIRECT_URI = "https://client.example.com/callback";

/** A user as GitHub's `GET /user` returns it, limited to the fields the Worker reads. */
export type GitHubUser = { id: number; login: string; name: string | null };

/** The GitHub user that `githubHandlers()` signs in by default. */
export const GITHUB_USER: GitHubUser = { id: 583231, login: "octocat", name: "The Octocat" };

/**
 * Sends a request to the Worker entry, so the OAuth provider, the Hono app, and the MCP handler
 * all run. A relative path is resolved against `ORIGIN`. Redirects come back unfollowed, so tests
 * can read `Location`.
 */
export function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  // The entry's `fetch` follows redirects by default and sends every hop to this Worker, whatever
  // its host, so a redirect to GitHub or to the client would otherwise land on the Worker.
  return exports.default.fetch(new Request(new URL(path, ORIGIN), { ...init, redirect: "manual" }));
}

/**
 * Sets `ALLOWED_GITHUB_LOGINS` to `initial` before each test, lets a test change it through the
 * returned setter, and restores the configured value after each test. The default `*` admits
 * every account, because the configured value is empty and admits no one. The Worker reads the
 * same `env` object that `cloudflare:workers` exports, so an assignment reaches it.
 */
export function useAuthVars(initial = "*"): (allowedLogins: string) => void {
  const original = { ALLOWED_GITHUB_LOGINS: env.ALLOWED_GITHUB_LOGINS };
  beforeEach(() => {
    env.ALLOWED_GITHUB_LOGINS = initial;
  });
  afterEach(() => {
    Object.assign(env, original);
  });
  return (allowedLogins) => {
    env.ALLOWED_GITHUB_LOGINS = allowedLogins;
  };
}

/** Holds the cookies a browser would keep between requests. */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  /** Stores the cookies from a response, and drops the ones it expires. */
  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired) {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, pair.slice(separator + 1).trim());
      }
    }
  }

  /** Returns the `Cookie` header value for the stored cookies. */
  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Returns the S256 PKCE challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

const registrationSchema = z.looseObject({ client_id: z.string() });

/** Registers a public client through dynamic client registration and returns its client ID. */
export async function registerClient(clientName = "Test Client"): Promise<string> {
  const response = await workerFetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [CLIENT_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Registration returned HTTP ${response.status}: ${await response.text()}`);
  }
  return registrationSchema.parse(await response.json()).client_id;
}

/** An MCP client partway through authorization, with its browser's cookies. */
export interface Authorization {
  clientId: string;
  /** The PKCE verifier the client keeps for the token exchange. */
  verifier: string;
  /** The `state` the client sent, which comes back on its redirect. */
  state: string;
  jar: CookieJar;
}

/** Registers a client, builds its authorization request, and opens `GET /authorize`. */
export async function openConsent(clientName?: string) {
  const clientId = await registerClient(clientName);
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT_URI,
    scope: "profile",
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const jar = new CookieJar();
  const response = await workerFetch(`/authorize?${params}`);
  jar.store(response);
  const authorization: Authorization = { clientId, verifier, state, jar };
  return { authorization, response, query: params };
}

/** Returns the consent handle from a rendered consent page. */
export function consentHandle(page: string): string {
  const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
  if (handle === undefined) {
    throw new Error("The consent page has no handle.");
  }
  return handle;
}

/** Posts the consent form with a decision and the checked scopes, sending the browser's cookies. */
export async function submitConsent(
  authorization: Authorization,
  handle: string,
  decision: "approve" | "deny",
  scopes: readonly string[] = ["profile"],
): Promise<Response> {
  const form = new URLSearchParams({ handle, decision });
  for (const scope of scopes) {
    form.append("scope", scope);
  }
  const response = await workerFetch("/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: authorization.jar.header(),
    },
    body: form,
  });
  authorization.jar.store(response);
  return response;
}

/** Returns a response's `Location` header as a URL, or fails the test. */
export function location(response: Response): URL {
  const value = response.headers.get("Location");
  if (value === null) {
    throw new Error(`Expected a redirect, got HTTP ${response.status}.`);
  }
  return new URL(value);
}

/** What the GitHub handlers received, for assertions about the upstream exchange. */
export interface GitHubCalls {
  /** The `code_verifier` that the Worker sent with the code exchange. */
  verifier?: string;
}

/**
 * MSW handlers that stand in for GitHub's token endpoint and `GET /user`. The token endpoint
 * accepts only the code `test-github-code`, and answers anything else the way GitHub does: status
 * 200 with an `error` field.
 */
export function githubHandlers(
  user: GitHubUser = GITHUB_USER,
  calls: GitHubCalls = {},
): HttpHandler[] {
  return [
    http.post("https://github.com/login/oauth/access_token", async ({ request }) => {
      const body = await request.formData();
      const verifier = body.get("code_verifier");
      calls.verifier = typeof verifier === "string" ? verifier : undefined;
      if (body.get("code") !== "test-github-code") {
        return HttpResponse.json({ error: "bad_verification_code" });
      }
      return HttpResponse.json({
        access_token: "gho_test_token",
        token_type: "bearer",
        scope: "read:user",
      });
    }),
    http.get("https://api.github.com/user", ({ request }) => {
      if (request.headers.get("Authorization") !== "Bearer gho_test_token") {
        return HttpResponse.json({ message: "Bad credentials" }, { status: 401 });
      }
      return HttpResponse.json(user);
    }),
  ];
}

/**
 * Runs the browser half of the flow up to GitHub: opens the consent page and approves it.
 * Returns the GitHub authorize URL that the Worker redirected to.
 */
export async function approveConsent(clientName?: string) {
  const { authorization, response } = await openConsent(clientName);
  const handle = consentHandle(await response.text());
  const approved = await submitConsent(authorization, handle, "approve");
  return { authorization, github: location(approved) };
}

/** Calls `GET /callback` the way GitHub's redirect would, with the browser's cookies. */
export async function githubCallback(
  authorization: Authorization,
  params: Record<string, string>,
): Promise<Response> {
  const response = await workerFetch(`/callback?${new URLSearchParams(params)}`, {
    headers: { Cookie: authorization.jar.header() },
  });
  authorization.jar.store(response);
  return response;
}

const tokenSchema = z.looseObject({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
});

/** Exchanges an authorization code at `POST /token` with the client's PKCE verifier. */
export async function exchangeCode(authorization: Authorization, code: string) {
  const response = await workerFetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT_URI,
      client_id: authorization.clientId,
      code_verifier: authorization.verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `The token endpoint returned HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return tokenSchema.parse(await response.json());
}

/**
 * Sends a refresh token to `POST /token` as the client and returns the raw response, so tests can
 * assert on a failure as well as a success.
 */
export function refreshToken(authorization: Authorization, token: string): Promise<Response> {
  return workerFetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: authorization.clientId,
    }),
  });
}

/**
 * Mints an access token for `/mcp` through the whole flow. The caller must have the MSW network
 * enabled with `githubHandlers()`, and `ALLOWED_GITHUB_LOGINS` must admit the user, as
 * `useAuthVars()` arranges.
 */
export async function mintAccessToken(): Promise<string> {
  const { authorization, github } = await approveConsent();
  const callback = await githubCallback(authorization, {
    code: "test-github-code",
    state: github.searchParams.get("state") ?? "",
  });
  const code = location(callback).searchParams.get("code");
  if (code === null) {
    throw new Error("The callback redirect carries no authorization code.");
  }
  return (await exchangeCode(authorization, code)).access_token;
}
