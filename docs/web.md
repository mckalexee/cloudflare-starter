# Web app

The web app is a React Router 8 app in framework mode, rendered on the server inside the Worker.
Hono sits in front of it: Hono serves the plain HTTP routes and hands every other request to
React Router. This page covers how a request reaches a route, how identity and bindings reach
loaders, how to keep a site public or make it private with Cloudflare Access, and how to add a
route or Tailwind.

## How a request reaches a route

1. The Worker entry, `src/worker.ts`, passes the request to the Hono app from
   `src/http/index.ts`.
2. Hono runs request logging and the security headers, then tries its own routes, such as
   `/healthz` and `/api/*`.
3. The catch-all, `app.all("*")`, registered last, creates a `RouterContextProvider` and fills two
   router contexts from `src/web/context.ts`:
   - `cloudflareContext` holds `env` and `ctx` for the request.
   - `identityResolverContext` holds a function that resolves the Access identity on its first
     call and returns the same promise after that.
4. React Router matches the route, runs the root route's middleware, then the loaders, and
   `src/web/entry.server.tsx` streams the HTML.

Static files in `public/` never reach the Worker. The assets router serves them first.

`react-router.config.ts` sets `appDirectory: "src/web"` and `ssr: true`. `vite.config.ts` puts
`cloudflare({ viteEnvironment: { name: "ssr" } })` before `reactRouter()` so the two plugins
share the `ssr` environment, and pins the dev server to port 5173.

## Identity in loaders

The root route, `src/web/root.tsx`, exports a middleware that runs for every route. For any
route whose pattern isn't in `PUBLIC_PATHS`, it runs `requireIdentityMiddleware` from
`src/web/middleware.ts`, which:

1. Resolves the identity through `identityResolverContext`.
2. Stores it in `identityContext`.
3. On a private site, throws a 403 response when there is no identity.

A loader reads the result after the middleware has run:

```tsx
import { identityContext } from "#web/context.ts";

import type { Route } from "./+types/account.ts";

export function loader({ context }: Route.LoaderArgs) {
  return { identity: context.get(identityContext) };
}
```

`identityContext` holds `{ email, name? }` or `null`. On a public route, the gate doesn't run, so
`identityContext` stays `null`. A public page that wants to know who is signed in calls the
resolver itself:

```tsx
const identity = await context.get(identityResolverContext)();
```

`GET /api/me` in `src/http/routes/api.ts` shows the same gate for Hono routes:
`requireIdentity()` from `src/http/access.ts` sets the `identity` variable and returns 403 on a
private site without one.

### The public list

`PUBLIC_PATHS` in `src/web/root.tsx` lists the route patterns that anyone may see on a private
site, written the way React Router reports them, such as `/` or `/blog/:slug`. Every other route
needs an identity, so a new route stays private until you add it to the list. The template lists
only `/`.

### Where the identity comes from

`resolveIdentity()` in `src/http/access.ts` checks two sources:

1. `ctx.access`, when the runtime provides it. Cloudflare's documentation says that local
   development with `wrangler dev` or the Cloudflare Vite plugin, which `pnpm dev` runs,
   simulates it from the `access.dev` block in `wrangler.jsonc`. In production, only a Worker
   without static assets that Access protects directly receives it.
2. Otherwise, the `Cf-Access-Jwt-Assertion` header, which it verifies with `jose` against the
   team's signing keys at `https://<team>/cdn-cgi/access/certs`, with the issuer
   `https://<team>`, the audience `ACCESS_AUD`, and the RS256 algorithm.

In production, this Worker serves static assets, and the assets router in front of it doesn't
pass `ctx.access` to the Worker. That's why `access.ts` verifies the JWT itself. A token without
an `email` claim, such as a Cloudflare Access service token's, counts as no identity, so private
routes reject it. To accept service tokens, build an identity from the `common_name` claim in
`identityFromToken()`.

## Public and private sites

Whether the site is private is configuration, not code:

| `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` | Result                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Both empty                            | Public site. Every route renders without an identity, and `access.unconfigured` is logged once per isolate. |
| Both set                              | Private site. Routes outside `PUBLIC_PATHS` and `/api/me` need a valid Access JWT.                          |
| Only one set                          | Configuration error. Requests that check identity fail with a 500 response, so the site fails closed.       |

Set the vars at the top level of `wrangler.jsonc` and again in `previews.vars`, because Previews
inherit nothing. [Cloudflare Access applications](#cloudflare-access-applications) covers the
applications that put the site behind a login, and which AUD each block needs.

A public site can keep `src/http/access.ts` and the middleware as they are. The empty vars turn
the gate off.

## Bindings in loaders

Read the Worker's bindings and execution context from `cloudflareContext`:

```tsx
import { cloudflareContext } from "#web/context.ts";

import type { Route } from "./+types/home.ts";

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { appName: env.APP_NAME };
}
```

`env` has the same type as everywhere else in the Worker, generated from `wrangler.jsonc` by
`pnpm typegen`. `ctx` offers `waitUntil()` for work that may finish after the response, such as a
cache write.

## Add a route

1. Create the route module, such as `src/web/routes/reports.tsx`, with a header comment, a
   `loader` if the page needs data, a `meta` export for the title, and a default component.
2. Add it to `src/web/routes.ts`:

   ```ts
   export default [
     index("routes/home.tsx"),
     route("account", "routes/account.tsx"),
     route("reports", "routes/reports.tsx"),
   ] satisfies RouteConfig;
   ```

3. Run `pnpm typegen` to generate `./+types/reports.ts`, which the module imports for its types.
4. On a private site, decide whether the page is public. If it is, add its pattern to
   `PUBLIC_PATHS`.
5. Add a test in `test/web/` that renders the route through `exports.default.fetch`, as
   `test/web/account.test.ts` does.

A route that throws `data({ message }, { status })` gets that message on the error page from the
root `ErrorBoundary`. Any other error renders a generic message.

## Errors and logging

`src/web/entry.server.tsx` exports `handleError`, which React Router calls for an error that a
loader, an action, or rendering throws. It logs `ssr.unhandled_error` with the path, and skips
requests that the client aborted. Errors that happen after the HTML shell has started streaming
surface in `onError`, which logs them as `ssr.stream_error`. `isbot` detects crawlers, which get
the complete document instead of a stream. `streamTimeout` gives deferred loader data five seconds.

## Add Tailwind CSS

The template ships without a CSS framework. To add Tailwind CSS 4:

1. Install the packages:

   ```sh
   pnpm add -DE tailwindcss @tailwindcss/vite
   ```

2. In `vite.config.ts`, import the plugin and add it after `reactRouter()`:

   ```ts
   import tailwindcss from "@tailwindcss/vite";

   // in plugins:
   tailwindcss(),
   ```

3. Create `src/web/app.css`:

   ```css
   @import "tailwindcss";
   ```

4. In `src/web/root.tsx`, import the stylesheet's URL and export a `links` function:

   ```tsx
   import stylesheet from "./app.css?url";

   /** Loads the Tailwind stylesheet on every page. */
   export const links: Route.LinksFunction = () => [{ rel: "stylesheet", href: stylesheet }];
   ```

5. Run `pnpm verify`.

The build writes the CSS to `build/client/assets/`, and the assets router serves it. The tests
need no change.

The default `secureHeaders()` in `src/http/index.ts` sets no Content-Security-Policy, because a
policy must allow the inline scripts that React Router uses for hydration. If you add one, test
hydration in the browser.

## Cloudflare Access applications

`src/http/access.ts` verifies the Access JWT for the web app and `/api`. This section covers the
Access applications that put the site behind a login.

Set `ACCESS_TEAM_DOMAIN` to the team domain, such as `myteam.cloudflareaccess.com`. The Zero Trust
dashboard shows it under **Settings** > **Team name and domain**. Through the API,
`GET /accounts/<account-id>/access/organizations` returns it as `result.auth_domain`. That call
needs a token with **Access: Organizations Read** or **Access: Organizations, Identity Providers,
and Groups Read**. Set `ACCESS_AUD` to the `aud` of the allow application.

### The allow application

The allow application admits the people that its policy names. `allow-app.json`:

```json
{
  "type": "self_hosted",
  "name": "<name> web app",
  "domain": "<host>",
  "destinations": [{ "type": "public", "uri": "<host>" }],
  "session_duration": "24h",
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

### Web app only

Create the allow application on the hostname. It protects every path, and `access.ts` verifies
the JWT that Access adds to each request. Add a bypass application for `/healthz`, so the deploy
workflow's health check reaches the Worker instead of the Access login page. `bypass-app.json`:

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

You can also protect the Worker itself from **Workers & Pages** > your Worker > **Access**, which
covers every hostname and Preview of the Worker. Use the AUD of whichever application protects
the hostname.

A self-hosted application needs a hostname on a zone in your account, so Worker-level Access is
how you protect a site on its `workers.dev` hostname. It covers `/healthz` too, with no bypass,
so leave the `HEALTHCHECK_URL` repository variable unset.

<!-- @starter:mcp -->

### Both halves on one hostname

Worker-level Access would block `/mcp`, the OAuth endpoints, and the discovery documents, and MCP
clients can't complete an Access login, so a private web app next to MCP needs a custom domain.
On that hostname, use two self-hosted applications instead: the allow application, and a bypass
application for the health check and the MCP and OAuth paths. Access applies the most specific
match first, so the bypass application wins on its paths and the allow application covers
everything else. `bypass-app.json`:

```json
{
  "type": "self_hosted",
  "name": "<name> MCP and OAuth",
  "domain": "<host>/mcp",
  "destinations": [
    { "type": "public", "uri": "<host>/healthz" },
    { "type": "public", "uri": "<host>/mcp" },
    { "type": "public", "uri": "<host>/authorize" },
    { "type": "public", "uri": "<host>/token" },
    { "type": "public", "uri": "<host>/register" },
    { "type": "public", "uri": "<host>/callback" },
    { "type": "public", "uri": "<host>/.well-known/*" }
  ],
  "policies": [
    {
      "name": "MCP clients and OAuth",
      "decision": "bypass",
      "include": [{ "everyone": {} }]
    }
  ]
}
```

The bypass application leaves those paths open to everyone. That's intended: `/healthz` reveals
nothing, and the consent page, the token endpoint, and `/mcp` do their own checks.

### Both halves on two hostnames

Alternatively, serve the Worker on two custom domains, such as `app.example.com` for the web app
and `mcp.example.com` for MCP clients:

1. Add both to `routes` in `wrangler.jsonc` with `custom_domain: true`.
2. Create one allow application on `app.example.com`, and none on `mcp.example.com`.
3. With GitHub OAuth, set `MCP_RESOURCE` to `https://mcp.example.com/mcp` and register
   `https://mcp.example.com/callback` with GitHub.
4. Set the `HEALTHCHECK_URL` repository variable to `https://mcp.example.com`, which Access
   doesn't cover.

The web pages also answer on `mcp.example.com`. Requests there carry no Access JWT, so private
pages answer 403 while public pages render.

<!-- @starter:end -->

### Create the applications

Create the bypass application first, so its paths are never blocked, then the allow application.
Use an API token that has the **Access: Apps and Policies Write** permission.

Keep the payload files out of the repository, because the allow policy holds email addresses.
Create a temporary directory:

```sh
payloads=$(mktemp -d)
```

Save the payloads as `"$payloads/bypass-app.json"` and `"$payloads/allow-app.json"`. Then create
the applications and delete the directory:

```sh
for app in bypass-app.json allow-app.json; do
  curl -sS "https://api.cloudflare.com/client/v4/accounts/<account-id>/access/apps" \
    --request POST \
    --header "Authorization: Bearer $ACCESS_API_TOKEN" \
    --header "Content-Type: application/json" \
    --data "@$payloads/$app" \
    | jq '{success, errors, name: .result.name, aud: .result.aud}'
done
rm -r "$payloads"
```

In the dashboard, the same applications are **Zero Trust** > **Access controls** >
**Applications** > **Create new application** > **Self-hosted**, with the hostname and paths as
destinations and the policy action set to **Allow** or **Bypass**.

### Access on Previews

Previews don't match a production hostname application. With the Access vars set in
`previews.vars`, private pages on a Preview answer 403 and public pages keep working. To use
private pages on Previews, protect the Worker's Previews from **Workers & Pages** > your Worker >
**Access** > **Previews only**, and set `ACCESS_AUD` in `previews.vars` to that application's AUD.

<!-- @starter:mcp -->

That application also covers `/mcp` on Previews, so MCP clients can't reach a Preview's MCP
endpoint.

<!-- @starter:end -->
