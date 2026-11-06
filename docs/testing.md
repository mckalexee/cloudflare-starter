# Testing

Tests run inside workerd, the runtime that serves the deployed Worker, through
`@cloudflare/vitest-plugin`. They use the bindings from `wrangler.jsonc`, the real Worker entry,
and real KV storage, and they never reach the network.

## Run the tests

```sh
pnpm test                             # every test once
pnpm test test/http/healthz.test.ts   # one file
pnpm test -t "returns the message"    # tests whose name matches
pnpm test:watch                       # rerun on change
pnpm test:coverage                    # coverage report in coverage/
pnpm test --no-isolate                # every file in one shared runtime
```

Each test file runs in its own isolated runtime by default. `--no-isolate` runs them all in one,
so state that one file leaves behind, such as a KV key or a changed var, can reach the next. Run
it before you merge a change to shared helpers or to anything with module-level state. When it
fails and the normal run passes, a test depends on the order the files run in.

## Configuration

`vitest.config.ts` sets up the runtime:

- `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` loads the Worker's bindings
  and compatibility settings from the same file that production uses.

<!-- @starter:oauth -->

- `miniflare.bindings` supplies fixed test values for the secrets in `secrets.required`, and sets
  `MCP_RESOURCE` to `http://localhost:5173/mcp`, so tests never read `.dev.vars`. A new secret
  needs a value here.

<!-- @starter:end -->

- `reactRouter()` in `plugins` resolves `virtual:react-router/server-build`, so requests reach the
  real Worker entry and the real web app.
- `environments.ssr.resolve.conditions` puts back the Workers resolve conditions (`workerd`,
  `worker`, `module`, `browser`). The React Router plugin sets its own conditions for the `ssr`
  environment, which drops them, and without them packages such as `@msw/cloudflare` load their
  Node entry instead of their Workers entry. The values match the Cloudflare Vite plugin's
  production build.
- `testTimeout` is 15 seconds instead of vitest's 5. The first request in a test file loads the
  Worker and its dependencies, which can take longer than five seconds on a busy machine.
- `coverage` uses istanbul over `src/**`. Istanbul instruments the code before it runs, so it
  works inside workerd, where V8 coverage isn't available.

## Call the Worker

Import `exports` from `cloudflare:workers` and call `exports.default.fetch()` to send a request
through the real entry and every layer that it composes.

```ts
import { exports } from "cloudflare:workers";

const response = await exports.default.fetch("http://example.com/healthz");
```

<!-- @starter:oauth -->

`workerFetch(path, init)` from `test/helpers/oauth.ts` does the same with paths relative to
`http://localhost:5173`, and returns redirects without following them, so a test can read
`Location`.

<!-- @starter:end -->

<!-- @starter:web -->

The vitest plugin doesn't populate `ctx.access`. To test the `ctx.access` branch of
`resolveIdentity()`, call it directly with a context object that has an `access` property, as
`test/http/access.test.ts` does. Requests through `exports.default.fetch()` test the JWT branch.

<!-- @starter:end -->

## Change vars in a test

`env` from `cloudflare:workers` is the same object that the Worker reads, so assigning to it
changes what the Worker sees. Restore every change after the test, or a later test sees it. For
a one-off change, save the value and restore it in `finally`.

<!-- @starter:web -->

`useAccessVars()` from `test/helpers/access.ts` returns a setter for `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD`, and restores them after each test.

<!-- @starter:end -->

<!-- @starter:oauth -->

`useAuthVars(initial)` from `test/helpers/oauth.ts` sets `ALLOWED_GITHUB_LOGINS` to `initial`
before each test, `*` by default, returns a setter, and restores the value after each test.

<!-- @starter:end -->

To pass different bindings to one call only, spread `env` into a new object, such as
`{ ...env, APP_NAME: "Test" }`, and pass it to code that takes `env` as an argument. The Hono
app's `fetch(request, env, ctx)` takes it, and its routes read the object as `c.env`.

<!-- @starter:mcp -->

The bearer token check in `src/auth/bearer.ts` also reads the `env` that you pass. MCP tools
don't. The MCP handler gives each tool the module-level `env` from `cloudflare:workers`, whatever
`env` you pass to the handler, so such a test still runs the tool with the default values. To
change a binding that a tool reads, assign to `env` from `cloudflare:workers` and restore it after
the test, as the start of this section describes.

<!-- @starter:end -->

## Mock outbound requests

Call `useNetwork()` from `test/helpers/network.ts` at the top of any test file whose code makes
outbound requests. It enables MSW through `@msw/cloudflare` for the file and returns the network
object:

- A catch-all handler answers every request that no test handler matches with a network error,
  so no test reaches the real network, and a missing mock fails fast in the code under test.
- `network.use(...handlers)` adds handlers for one test. They're removed after each test.
- If a test replaces the catch-all with `network.resetHandlers(handler)`, a request that no
  handler matches fails instead of reaching the real network.

```ts
import { http, HttpResponse } from "msw";

import { useNetwork } from "../helpers/network.ts";

const network = useNetwork();

it("reads the upstream value", async () => {
  network.use(http.get("https://api.example.com/value", () => HttpResponse.json({ value: 1 })));
  // ...
});
```

<!-- @starter:mcp -->

## Test MCP tools

`createMcpClient(fetcher, options)` from `test/helpers/mcp.ts` is a small JSON-RPC client for the
Streamable HTTP transport. It works with any function that takes a `Request` and returns a
`Response`, reads both JSON and Server-Sent Events bodies, and checks each result's shape:

- `initialize()`, `listTools()`, and `callTool(name, args)` return the checked `result`.
- A JSON-RPC error throws `JsonRpcError`, and a non-2xx status throws an `Error` with the body.
- `post(method, params)` returns the raw response, for tests of status codes and headers.
- `resultText(result)` returns the text of a tool result's first content block.

[mcp.md](mcp.md#test-a-tool) explains which client to use for a tool test and has a worked
example.

<!-- @starter:end -->

<!-- @starter:oauth -->

`createOAuthMcpClient(accessToken)` points the client at `/mcp` through the Worker entry with an
OAuth access token.

## Test the OAuth flow

`test/helpers/oauth.ts` drives the real flow through the Worker entry, the way an MCP client and a
browser would, with GitHub replaced by MSW:

| Helper                                                   | What it does                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `registerClient(name)`                                   | Registers a public client with `POST /register` and returns its client ID.                                             |
| `openConsent(name)`                                      | Registers a client and opens `GET /authorize` with PKCE.                                                               |
| `consentHandle(page)`                                    | Reads the consent handle from the page.                                                                                |
| `submitConsent(authorization, handle, decision, scopes)` | Posts the consent form with the browser's cookies.                                                                     |
| `approveConsent(name)`                                   | Opens the consent page, approves it, and returns the GitHub redirect.                                                  |
| `githubHandlers(user, calls)`                            | MSW handlers for GitHub's token endpoint and `GET /user`. The token endpoint accepts only the code `test-github-code`. |
| `githubCallback(authorization, params)`                  | Calls `GET /callback` the way GitHub's redirect would.                                                                 |
| `exchangeCode(authorization, code)`                      | Exchanges the code at `POST /token`.                                                                                   |
| `refreshToken(authorization, token)`                     | Sends a refresh token and returns the raw response.                                                                    |
| `mintAccessToken()`                                      | Runs the whole flow and returns an access token for `/mcp`.                                                            |
| `CookieJar`                                              | Keeps the cookies a browser would between requests.                                                                    |

`mintAccessToken()` needs `useNetwork()` with `githubHandlers()` in place, and an
`ALLOWED_GITHUB_LOGINS` that admits the user, which `useAuthVars()` sets up:

```ts
const network = useNetwork();
useAuthVars();

it("calls a tool as the GitHub user", async () => {
  network.use(...githubHandlers());
  const client = createOAuthMcpClient(await mintAccessToken());
  // ...
});
```

<!-- @starter:end -->

<!-- @starter:web -->

## Test Cloudflare Access

`createAccessIssuer()` from `test/helpers/access.ts` creates a fake Access issuer with its own
RS256 key pair and a random team domain:

- `issuer.certs` is an MSW handler that serves the public key at the team's certificates URL.
- `issuer.sign(claims, options)` signs an application token. The options change the audience, the
  issuer, or the expiry, or sign with an untrusted key or with HS256, to test rejections.

Each issuer has its own team domain, and the Worker caches signing keys per team domain, so no
test reuses another test's keys. A private-site test enables the network, adds `issuer.certs`,
sets the vars with `useAccessVars()`, and sends the signed token in `Cf-Access-Jwt-Assertion`, as
`test/web/account.test.ts` does.

<!-- @starter:end -->

## Logs in tests

`src/lib/log.ts` writes to `console`, so tests that expect a warning or an error spy on the
console method and parse the JSON line. Restore spies with `vi.restoreAllMocks()` in `afterEach`.
