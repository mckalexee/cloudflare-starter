# Auth

This page explains how MCP clients authenticate to the MCP endpoint at `/mcp`.

<!-- @starter:oauth -->

MCP clients sign in through OAuth. The page covers the sign-in flow, what the OAuth library does
for you, how to configure GitHub, and how to swap GitHub for another identity provider.
[Bearer mode](#bearer-mode) replaces OAuth with one static token for a single user.

<!-- @starter:end -->

<!-- @starter:access -->

[Cloudflare Access sign-in](#cloudflare-access-sign-in) is an alternative mode that this project
can switch to, where Cloudflare Access signs MCP clients in and the Worker needs no secrets.

<!-- @starter:end -->

<!-- @starter:oauth -->

The Worker is both the OAuth authorization server and the resource server for its MCP endpoint.
`OAuthProvider` from `@cloudflare/workers-oauth-provider` plays both roles. `src/worker.ts` builds
one provider per resource URL through `src/auth/provider.ts`, and every request passes through it
first.

## The sign-in flow

1. **Challenge.** An MCP client sends `POST /mcp` without a token. The provider answers `401` with
   a `WWW-Authenticate` header whose `resource_metadata` parameter points at
   `/.well-known/oauth-protected-resource/mcp`.
2. **Discovery.** The client reads the protected resource metadata, which names the resource URL
   and this Worker as its authorization server, and then reads
   `/.well-known/oauth-authorization-server` for the endpoints and the supported scopes.
3. **Registration.** The client registers with `POST /register` (dynamic client registration), or
   identifies itself with the URL of a Client ID Metadata Document instead.
4. **Authorization.** The client opens `GET /authorize` in the user's browser.
   `src/auth/authorize.ts` validates the request and the client. If the browser holds a
   remembered approval for this client, it skips to step 6.
5. **Consent.** The consent page names the client, says whether its domain is verified, shows the
   host that will receive the tokens, and lists each scope as a checked box. The user approves
   or denies with `POST /authorize`. Deny sends the client `access_denied`.
6. **GitHub.** The Worker redirects the browser to GitHub with a PKCE challenge and a `state` that
   the library bound to the browser.
7. **Callback.** GitHub redirects to `GET /callback`. `src/auth/upstream/github.ts` recovers the
   approved request, exchanges the code with the PKCE verifier, reads `GET /user`, checks
   `ALLOWED_GITHUB_LOGINS`, and completes the authorization. The browser returns to the client's
   redirect URI with an authorization code.
8. **Token.** The client exchanges the code at `POST /token` and gets an access token and a
   refresh token.
9. **MCP.** The client calls `/mcp` with the access token. The provider validates it and passes
   the grant's props to the MCP handler, which the tools receive as `props`.

Consent comes before the GitHub redirect on purpose. Every MCP client reaches GitHub through this
server's one OAuth app, so asking per client stops one client from reusing the approval that the
user gave another.

## What the library does

The template uses the library's consent and upstream helpers instead of hand-rolled CSRF and
state handling.

| Concern              | What happens                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent binding      | `beginConsent()` stores a single-use handle and returns headers that set a `__Host-` cookie binding the handle to the browser and forbid framing. `approveConsent()` and `denyConsent()` reject a handle without the matching cookie.                   |
| Upstream transaction | `beginUpstream()` saves the approved request and the PKCE verifier in KV, encrypted, and returns the `state` for GitHub. `finishUpstream()` recovers them once, and only in the browser that started the flow.                                          |
| Remembered consent   | `approveConsent()` with `remember` sets a cookie signed with `COOKIE_SECRET` and bound to the client, its redirect URI, and the resource. The template keeps it for 7 days instead of the library's 30. `COOKIE_SECRET` must be at least 32 characters. |
| Props encryption     | `completeAuthorization()` stores the props, including the user's GitHub token, encrypted with the grant.                                                                                                                                                |
| Refresh re-check     | `tokenExchangeCallback` in `src/auth/provider.ts` checks `ALLOWED_GITHUB_LOGINS` again on every refresh. An account that's no longer allowed gets `invalid_grant`, and the provider revokes the grant.                                                  |
| Token lifetimes      | Access tokens last one hour and refresh tokens 30 days, the library's defaults.                                                                                                                                                                         |
| Resource binding     | Every token is bound to the resource URL that the provider was built with, and `/mcp` accepts only tokens for its own resource.                                                                                                                         |

Because only refreshes re-check the allowlist, an account that you remove keeps working until its
current access token expires, which takes at most one hour.

## The resource URL

`resolveResource()` in `src/auth/resource.ts` decides the resource URL for each request:

- **Loopback:** on `localhost`, `127.0.0.1`, or `[::1]`, it's the request's origin plus `/mcp`.
  `pnpm dev` needs no setting, and a deployed Worker never sees a loopback hostname.
- **Configured:** otherwise, a non-empty `MCP_RESOURCE` wins. Production sets it to the URL that
  clients use, such as `https://mcp.example.com/mcp`.
- **Previews:** with `ENVIRONMENT` set to `preview` and an empty `MCP_RESOURCE`, a request on a
  `*.workers.dev` hostname derives the URL from its own origin, so each Preview gets its own.
- **Anything else** is a configuration error. Every request then fails with a 500 response whose
  message names `MCP_RESOURCE`.

`MCP_RESOURCE` must equal the URL that clients connect to, scheme and path included. When it
doesn't, clients can't complete sign-in, because the tokens name a different resource.

## The allowlist

`ALLOWED_GITHUB_LOGINS` decides who may sign in and keep refreshing tokens:

- Empty, the default, admits no one. A new deployment stays closed until you choose.
- `*` admits every GitHub account.
- Anything else is a comma-separated list of GitHub logins, numeric GitHub user IDs, or both.
  Entries are trimmed, and logins compare without case. A user ID keeps matching after the user
  renames their account.

A refused account gets `access_denied` at sign-in, and `invalid_grant` at refresh. It's a var, so
set it in `wrangler.jsonc` under both `vars` and `previews.vars`. Under `pnpm dev`, a `.dev.vars`
entry with its name overrides it.

## Endpoints

| Path                                        | Served by            | Purpose                                          |
| ------------------------------------------- | -------------------- | ------------------------------------------------ |
| `/mcp`                                      | Provider, then MCP   | The MCP endpoint. Answers `401` without a token. |
| `/.well-known/oauth-protected-resource/mcp` | Provider             | Protected resource metadata (RFC 9728)           |
| `/.well-known/oauth-authorization-server`   | Provider             | Authorization server metadata (RFC 8414)         |
| `/register`                                 | Provider             | Dynamic client registration                      |
| `/token`                                    | Provider             | Code exchange and refresh                        |
| `GET /authorize`, `POST /authorize`         | `src/auth/routes.ts` | Consent page and decision                        |
| `GET /callback`                             | `src/auth/routes.ts` | GitHub's redirect back                           |

RFC 9728 builds the metadata URL from the resource, so the protected resource metadata lives at
the path-suffixed URL, and the bare `/.well-known/oauth-protected-resource` returns 404. `public/`
has no `.well-known` directory, because the static assets router would serve it before the Worker
runs.

## Set up GitHub sign-in

GitHub has no API for creating OAuth apps, so create the app in the browser:

1. Go to <https://github.com/settings/applications/new>. For an app that an organization owns, go
   to the organization's **Settings** > **Developer settings** > **OAuth Apps**.
2. Enter an application name and a homepage URL.
3. Add the callback URLs, with wildcard matching off:
   - `https://<host>/callback` for production.
   - `http://localhost:5173/callback` for `pnpm dev`.
4. Register the app, generate a client secret, and store the values as `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`. [deploy.md](deploy.md#worker-secrets) shows where.

The Worker asks GitHub for `read:user`, set by `GITHUB_SCOPE` in `src/auth/upstream/github.ts`.
Add GitHub scopes there when a tool needs more of the user's GitHub account.

### Preview callbacks

Each Preview has its own hostname, `pr-<number>-<worker>.<subdomain>.workers.dev`, so its
callback URL is different for every pull request. Pick one approach:

- **Skip OAuth on Previews.** Don't give Previews the GitHub secrets. A Preview still deploys and
  passes the workflow's checks, but MCP sign-in fails there.
- **Use a second OAuth app for Previews.** Register `https://<subdomain>.workers.dev/callback` with
  wildcard matching on, which admits every subdomain, and store that app's values as Preview
  secrets. Wildcard matching lets any Worker on the account's `workers.dev` subdomain receive
  sign-in codes for the app, so never use the production app for this.
- **Register each Preview.** Add `https://pr-<number>-<worker>.<subdomain>.workers.dev/callback` to
  the Preview app for each pull request that needs sign-in.

## Security notes

- The consent form is protected by the library's binding cookie, not by Hono's `csrf()`
  middleware. The consent page sends `Referrer-Policy: no-referrer`, so the browser posts the form
  with `Origin: null`, and `csrf()` would reject every approval.
- MCP clients can open the consent page in a popup and wait on it through `window.opener`, so
  `src/http/index.ts` turns off Hono's default `Cross-Origin-Opener-Policy`.
- Never log props, tokens, cookies, or authorization codes. The auth routes log logins, user IDs,
  client IDs, and error codes only.

## Other identity providers

Each alternative replaces the GitHub module and keeps the provider, the consent page, and the
tools. The changes common to every OAuth alternative:

- Replace `src/auth/upstream/github.ts` with a module that exports a redirect function and a
  callback handler, and update the imports in `src/auth/authorize.ts` and `src/auth/routes.ts`.
- Rename the GitHub secrets in `secrets.required`, `.dev.vars.example`, the `TEST_SECRETS` in
  `vitest.config.ts`, and the secrets step of `.github/workflows/preview.yml`. Run
  `pnpm typegen`.
- Change the GitHub wording in `src/auth/consent.ts` ("Next, GitHub asks you to sign in.") and in
  `SCOPE_DESCRIPTIONS` in `src/env.ts`.
- Store the provider's user ID as `id`. `id` in `AuthProps` is a string, which fits Google and
  Entra user IDs, and a Google `sub` can exceed the largest safe JavaScript integer.
- Keep `ALLOWED_GITHUB_LOGINS` or rename it, such as to `ALLOWED_USERS`. The allowlist matches an
  entry against `login` without case and against `id` exactly, so store the email as `login` and
  list emails. The refresh re-check in `src/auth/provider.ts` reads `login` from the grant.
- Replace the GitHub stand-ins in `test/helpers/oauth.ts`. Sign test ID tokens with a key pair
  and serve its public key through MSW.
- `jose` verifies ID tokens. If `package.json` doesn't list it, add it with `pnpm add -E jose`.

### Google

Create an OAuth client of type **Web application** in the Google Cloud console, under
**APIs & Services** > **Credentials**. Add `https://<host>/callback` and
`http://localhost:5173/callback` as authorized redirect URIs. Google matches redirect URIs exactly
and has no wildcards, so Previews either skip OAuth or get each URI registered.

Store the values as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The module differs from the
GitHub one in these parts:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Google issues ID tokens under either form of its issuer.
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

// Google answers a failed exchange with a 4xx status, which `fetchJson` turns into an
// `UpstreamError`, so the schema describes only a success.
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
});

const idTokenSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  // An unverified address can belong to someone else, so the allowlist can't trust it.
  email_verified: z.literal(true),
  name: z.string().optional(),
});
```

In the redirect, send `response_type: "code"` and `scope: "openid email profile"` next to the
same `client_id`, `redirect_uri`, `state`, `code_challenge`, and `code_challenge_method`
parameters. In the callback, replace the code exchange and `GET /user` with:

```ts
const tokens = await fetchJson(TOKEN_URL, {
  method: "POST",
  headers: { Accept: "application/json" },
  body: new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    client_secret: c.env.GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: callbackUrl(c),
  }),
  schema: tokenResponseSchema,
  service: "Google",
});
const { payload } = await jwtVerify(tokens.id_token, googleKeys, {
  issuer: ISSUERS,
  audience: c.env.GOOGLE_CLIENT_ID,
  algorithms: ["RS256"],
});
const claims = idTokenSchema.parse(payload);

const props: Omit<AuthProps, "scopes"> = {
  id: claims.sub,
  login: claims.email,
  name: claims.name ?? claims.email,
  accessToken: tokens.access_token,
};
// Pass `userId: claims.sub` to `completeAuthorization()`.
```

A failed `jwtVerify()` or schema check falls through to the callback's generic error branch,
which redirects the client with `server_error`.

### Microsoft Entra ID

Register an app in the Microsoft Entra admin center with the web redirect URIs
`https://<host>/callback` and `http://localhost:5173/callback`. Use the tenant-specific endpoints,
so only accounts in your tenant can sign in:

| Purpose         | URL                                                                   |
| --------------- | --------------------------------------------------------------------- |
| Authorization   | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize` |
| Token           | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token`     |
| Signing keys    | `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`   |
| ID token issuer | `https://login.microsoftonline.com/<tenant-id>/v2.0`                  |

The module follows the Google shape with these differences:

- Request `openid profile email offline_access` plus the Microsoft Graph scopes that your tools
  need, such as `User.Read`.
- Verify the ID token's `tid` against your tenant ID, and use its `oid` claim as `id` and as the
  grant's `userId`. `oid` is stable within the tenant. Allowlist `oid` values or
  `preferred_username`.
- Authenticate to the token endpoint with a certificate instead of a client secret, so there is no
  secret to rotate: send `client_assertion_type` set to
  `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a `client_assertion` JWT signed
  with RS256, with the certificate's base64url SHA-1 thumbprint as the `x5t` header, the token
  endpoint as `aud`, and the client ID as `iss` and `sub`. A client secret also works.
- Graph access tokens expire after about an hour, so store the Entra refresh token in the props
  as well. In `tokenExchangeCallback`, on a refresh, exchange the stored refresh token for new
  Graph tokens and return them as `newProps`, and return `accessTokenTTL` to match the new
  Graph token's lifetime.

With the certificate assertion, the Worker holds no client secret. With the refresh in
`tokenExchangeCallback`, Graph calls keep working for as long as the grant lives, without another
sign-in.

### Cloudflare Access as the identity provider

Access can be the sign-in for MCP clients through an Access for SaaS OIDC application, so the
people who reach your MCP server are the people your Access policies allow. Cloudflare's
[`remote-mcp-cf-access` demo](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access)
shows the flow.

1. In the Cloudflare dashboard, go to **Zero Trust** > **Access controls** > **Applications**,
   select **Create new application** > **SaaS application**, and choose **OIDC**.
2. Add the redirect URLs `https://<host>/callback` and `http://localhost:5173/callback`, turn on
   PKCE, and add a policy that names who may sign in.
3. Copy the client ID and client secret. The endpoints all start with the issuer URL,
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`:

   | Purpose       | Path after the issuer |
   | ------------- | --------------------- |
   | Authorization | `/authorization`      |
   | Token         | `/token`              |
   | Signing keys  | `/jwks`               |
   | User info     | `/userinfo`           |

The module follows the Google shape: request `openid email profile`, exchange the code at the
token endpoint with the client secret and the PKCE verifier, and verify the ID token against the
`/jwks` keys with the issuer URL from step 3 and the client ID as the audience. Use `sub` as `id`
and as the grant's `userId`, and `email` as `login`. Store the client ID and secret as secrets, such as
`ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`, and the issuer as a var.

<!-- @starter:end -->

<!-- @starter:oauth -->

Don't reuse `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, which name the self-hosted Access application
that `src/http/access.ts` verifies identities against.
[Cloudflare Access sign-in](#cloudflare-access-sign-in) needs no code of this kind.

<!-- @starter:end -->

<!-- @starter:oauth -->

The Access policy already decides who signs in, so `ALLOWED_GITHUB_LOGINS` (or its renamed
version) can be `*`, or a shorter list for defense in depth.

<!-- @starter:end -->

<!-- @starter:access -->

## Cloudflare Access sign-in

<!-- @starter:end -->

<!-- @starter:access -->

This project doesn't use this mode yet, so nothing mounts `accessRoutes`. To switch, mount the
routes in `src/http/index.ts` with `app.route("/", accessRoutes)`, make `src/worker.ts` export the
Hono app's handler with `export default appHandler;`, and delete the code that only the current
mode uses. Then create the Access application and set the vars. The rest of this section
describes the mode as it works once it's on.

<!-- @starter:end -->

<!-- @starter:access -->

In this mode, Cloudflare Access is the authorization server for `/mcp`, through its Managed OAuth
feature, which is in beta. An MCP client registers with Access, the person signs in on the Access
login page, and the client sends the token from Access with each request. Access checks the token
and the application's policy, and forwards the request with a signed `Cf-Access-Jwt-Assertion`
header. The Worker only verifies that header, so it needs no GitHub app and no secrets.

`accessRoutes` in `src/auth/access.ts` serves these paths:

| Path                                        | Purpose                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/mcp`                                      | Verifies the identity that Access forwards, and serves MCP as that person.            |
| `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728) that names Access as the authorization server. |
| `/.well-known/oauth-protected-resource`     | The same document at the URL without the path suffix.                                 |

<!-- @starter:end -->

<!-- @starter:access -->

### How the Worker checks a request

- `resolveIdentity()` from `src/http/access.ts` accepts an identity only from the application that
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` name. A JWT must carry that issuer and audience, and
  `ctx.access`, when the runtime provides it, must report that `aud`.
- The caller's `id` and `login` are the verified email in lowercase, and `name` is the name that
  Access reports, or the email. The Access policy already decided who may connect, so the caller
  gets every scope in `SCOPES` and no upstream token.
- Without an identity, `/mcp` answers `401` with `WWW-Authenticate: Bearer`. In production, Access
  answers an unauthenticated request before the Worker runs, so the Worker's own `401` means that
  no accepted identity arrived: on a Preview, on a hostname that the Access application doesn't
  cover, or with an `ACCESS_AUD` that doesn't match the application.
- With both Access vars empty, `/mcp` answers `401` and logs `auth.access_unconfigured` once per
  isolate, and the metadata documents answer `404`. Setting only one of the vars is an error that
  answers `500`.

Access can also authenticate a browser with its session cookie, and the Worker then sees the same
signed header as for an MCP client's token. So `/mcp` answers `403` to a request whose `Origin`
isn't the endpoint's own origin, or whose `Sec-Fetch-Site` is `cross-site` or `same-site`, and it
sends no CORS headers. A page on another site, or on a sibling subdomain, can't act with a
signed-in person's session. MCP clients that run outside a browser, such as Claude Code and the
claude.ai connectors, send neither header. A browser-based MCP client on another origin can't
connect in this mode.

### Access layouts

Every layout has an allow application with Managed OAuth turned on.

<!-- @starter:end -->

<!-- @starter:web -->

Pick the layout that fits the web app:

- **Host layout.** The allow application covers the whole hostname. Use it for MCP next to a
  private web app, where one application and one policy cover both. Access serves
  `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, and
  `/.well-known/oauth-authorization-server` itself. Add a bypass application on `/healthz`, as
  `bypass-app.json` shows, so the deploy workflow's health check reaches the Worker.
- **Path layout.** The allow application covers only `<host>/mcp`. Use it for MCP next to a public
  web app. Access doesn't serve the metadata documents in this layout, so those requests reach the
  Worker, which answers them. Without them, the Claude Code sign-in fails with a `404`. This layout
  needs no bypass application, because `/healthz` is outside it.

<!-- @starter:end -->

<!-- @starter:access -->

`allow-app.json` for the host layout:

```json
{
  "type": "self_hosted",
  "name": "<name>",
  "domain": "<host>",
  "destinations": [{ "type": "public", "uri": "<host>" }],
  "session_duration": "24h",
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,
      "allow_any_on_localhost": true,
      "allow_any_on_loopback": true,
      "allowed_uris": [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback"
      ]
    },
    "grant": { "access_token_lifetime": "15m", "session_duration": "24h" }
  },
  "policies": [
    {
      "name": "Allowed people",
      "decision": "allow",
      "include": [
        { "email": { "email": "ada@example.com" } },
        { "email_domain": { "domain": "example.com" } }
      ]
    }
  ]
}
```

<!-- @starter:end -->

<!-- @starter:web -->

For the path layout, set `domain` to `<host>/mcp` and the destination's `uri` to `<host>/mcp`.

<!-- @starter:end -->

<!-- @starter:access -->

These Managed OAuth settings are the ones that work with Claude Code and claude.ai:

- Dynamic client registration is on, so each client registers itself.
- `allow_any_on_localhost` and `allow_any_on_loopback` admit the redirect URIs of clients that run
  on your computer, such as Claude Code.
- `allowed_uris` admits the claude.ai and claude.com callbacks for the connectors.
- Access tokens last 15 minutes, and a sign-in lasts 24 hours.

`bypass-app.json` for the host layout:

```json
{
  "type": "self_hosted",
  "name": "<name> health check",
  "domain": "<host>/healthz",
  "destinations": [{ "type": "public", "uri": "<host>/healthz" }],
  "policies": [
    {
      "name": "Health check",
      "decision": "bypass",
      "include": [{ "everyone": {} }]
    }
  ]
}
```

Create the bypass application first, so the health check path is never blocked. The applications
need an API token with the **Access: Apps and Policies Write** permission. Send each payload with
`POST /accounts/<account-id>/access/apps`, and keep the payload files out of the repository,
because the allow policy holds email addresses.

### Set the vars

Set these in `wrangler.jsonc`, in both `vars` and `previews.vars`:

- `ACCESS_TEAM_DOMAIN`: the team domain, such as `myteam.cloudflareaccess.com`. The Zero Trust
  dashboard shows it under **Settings** > **Team name and domain**.
- `ACCESS_AUD`: the `aud` of the allow application, which the API returns as `result.aud`.

Under `pnpm dev`, Access doesn't run, so the dev server fakes `ctx.access` from the `access.dev`
block in `wrangler.jsonc`, and `/mcp` serves its identity. Set `access.dev.aud` to the same value
as `ACCESS_AUD`, or local requests have no identity.

The Access application doesn't cover Preview hostnames, so on a Preview, the Worker answers `/mcp`
with `401` and MCP clients can't sign in. If Worker-level Access protects the Previews, Access
answers `/mcp` instead of the Worker. Either way, MCP sign-in doesn't work on a Preview.

<!-- @starter:end -->

## Bearer mode

Bearer mode serves one user with one static token instead of a sign-in flow. `src/auth/bearer.ts`
checks the `Authorization: Bearer <token>` header against the `MCP_BEARER_TOKEN` secret in
constant time and serves MCP as the owner, with every scope and no upstream token.

Generate the token with `openssl rand -hex 32`, put it in `.dev.vars` for local use, and upload it
with `wrangler secret put MCP_BEARER_TOKEN` for production.
[deploy.md](deploy.md#bearer-mode-on-previews) covers Previews. Use bearer mode with clients that
can send a fixed header:

```sh
claude mcp add --transport http <name> https://<host>/mcp --header "Authorization: Bearer <token>"
```

<!-- @starter:oauth -->

### Switch an existing project to bearer mode

Choose bearer mode when you set up the project, and setup removes the OAuth code for you. To
switch a project that has already finished setup, make these changes by hand:

1. Delete `src/auth` except `src/auth/bearer.ts`, and delete `test/auth` and
   `test/helpers/oauth.ts`. Remove the OAuth client from `test/helpers/mcp.ts`.
2. Run `pnpm remove @cloudflare/workers-oauth-provider`.
3. In `src/worker.ts`, replace the OAuth provider with this routing, and drop the imports that
   only the provider used:

   ```ts
   import { bearerHandler } from "#auth/bearer.ts";
   import { MCP_ROUTE } from "#mcp/handler.ts";

   export default {
     fetch: (request, env, ctx) =>
       new URL(request.url).pathname === MCP_ROUTE
         ? bearerHandler.fetch(request, env, ctx)
         : appHandler.fetch(request, env, ctx),
   } satisfies ExportedHandler<Env>;
   ```

4. In `src/mcp/handler.ts`, delete `mcpApiHandler`, which only the OAuth provider calls. In
   `src/http/index.ts`, delete `authRoutes` and its import.
5. In `wrangler.jsonc`, set `secrets.required` to `["MCP_BEARER_TOKEN"]`, delete `MCP_RESOURCE`
   and `ALLOWED_GITHUB_LOGINS` from `vars` and `previews.vars`, and delete the
   `global_fetch_strictly_public` compatibility flag.
6. In `.dev.vars.example`, replace the GitHub and cookie secrets with `MCP_BEARER_TOKEN`. In
   `vitest.config.ts`, delete the OAuth test secrets and the `MCP_RESOURCE` binding.
7. In `.github/workflows/preview.yml`, delete the steps that write the OAuth secrets file and
   check the MCP sign-in challenge.
8. Run `pnpm typegen` and `pnpm verify`.

## Later: a separate authorization server

The template runs the authorization server and the resource server in one Worker, which the
library supports fully. When several MCP Workers should share one sign-in, move the authorization
server into its own Worker with the library's split API, and have each MCP Worker validate the
tokens it issues for that Worker's resource URL. Plan that move when a second MCP server needs the
same users and consent.

<!-- @starter:end -->
