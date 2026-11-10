# cloudflare-starter

One Cloudflare Worker with Hono in front. The README says what the project is and how to run it.
This file holds what you need to change it well.

Halves present: MCP endpoint (OAuth), web app.

<!-- @starter:mcp -->

The MCP endpoint is `/mcp`.

<!-- @starter:end -->

<!-- @starter:oauth -->

The OAuth provider in `src/auth` guards it, and users sign in with GitHub.

<!-- @starter:end -->

<!-- @starter:web -->

The web app is React Router 8 behind Hono, and Cloudflare Access can make it private.

<!-- @starter:end -->

## Commands

```sh
pnpm install                         # also runs pnpm typegen
pnpm dev                             # http://localhost:5173, secrets from .dev.vars
pnpm verify                          # format, lint, typecheck, tests, build, deploy dry run
pnpm test:watch                      # tests in watch mode
pnpm test:coverage                   # istanbul coverage report in coverage/
pnpm test test/http/healthz.test.ts  # one test file
pnpm fmt                             # fix formatting
pnpm typegen                         # regenerate the generated types
pnpm tail                            # stream the deployed Worker's live logs
```

- A change is done when `pnpm verify` passes. Run it before you report a change as finished.
- Never deploy unless the user asks you to. To deploy by hand, run `pnpm run deploy`, never
  `pnpm deploy`, which is a built-in pnpm command. A push to `main` deploys through
  `.github/workflows/deploy.yml` once the repository variable `DEPLOY_ENABLED` is `true`.
- Each pull request gets a Worker Preview named `pr-<number>`, and a comment with its URL.

## How to work

- Agree on the design before you build. Before you write product code, send the user a short
  brief: what the project does, each tool or page with its inputs and outputs, where the data
  comes from, and what it leaves out. Ask the questions that only the user can answer, such as
  which uses matter most and which defaults fit them, and wait for the answers. Don't choose
  the product for the user.
- Build in small steps: one tool, route, or upstream call at a time. Run `pnpm verify`, then
  commit. Don't end a session with work that isn't committed, and say in your last message what
  is deployed and what isn't.
- Ask for a credential before you write the code that needs it. Call the real service while you
  build, and capture its responses as test fixtures. A client written from documentation alone
  can't be checked.
- When you need something from the user, ask for one thing in a message that holds only that
  request, with the exact command or page. Do everything that doesn't depend on the answer
  first.
- If your tool can run subagents, give them the reading: API documentation, endpoint probing,
  and large responses. Ask for the conclusion, such as a response shape and a captured fixture,
  and keep the pages out of your own context.

## Layout

`src/worker.ts` is the composition root, the only module that knows about every area. Import a
module outside the current directory through its `#` subpath with the file extension, such as
`#lib/log.ts`. [docs/conventions.md](docs/conventions.md#file-layout-and-naming) has the rules.

<!-- @starter:mcp -->

`src/mcp` and `src/auth` never import `src/web`, `react`, or `react-router`. Oxlint enforces it,
so a project can delete the web app without breaking the MCP endpoint.

<!-- @starter:end -->

## Checklists

<!-- @starter:mcp -->

### Add an MCP tool

1. Create a module in `src/mcp/tools/` that exports a `defineTool()` registration.
2. Name it `<area>_<verb>_<noun>`. Write the description in four parts: when to call it, what
   the inputs mean, what it changes, and what it returns. Set `effect` and `openWorld`
   honestly, and set `scope` when it reads or changes the user's data. A new scope goes in
   `SCOPES` and `SCOPE_DESCRIPTIONS` in `src/env.ts`.
3. Add it to the array in `src/mcp/tools/index.ts`. The server instructions list it on their own.
4. Add tests in `test/mcp/`.

[docs/mcp.md](docs/mcp.md) has a worked example of a tool and its test.

### Replace the example tools

Change these together: the tool modules in `src/mcp/tools/` and their tests in `test/mcp/`,
`SCOPES` and `SCOPE_DESCRIPTIONS` in `src/env.ts`, and the `INSTRUCTIONS` text in
`src/mcp/instructions.ts`.

<!-- @starter:end -->

<!-- @starter:web -->

### Add a route

- HTTP route: add it to a router in `src/http/routes/`, mount it in `src/http/index.ts` before
  the catch-all, and throw `HttpError` for failures. Add `requireIdentity()` for a private route.
- Web page: add a module in `src/web/routes/` and an entry in `src/web/routes.ts`. On a private
  site, it needs an Access identity unless its pattern is in `PUBLIC_PATHS` in `src/web/root.tsx`.
- Add tests in `test/http/` or `test/web/`.

<!-- @starter:end -->

### Add a binding, var, or secret

1. Declare it at the top level of `wrangler.jsonc`.
2. Declare it again in the `previews` block. Previews inherit nothing from production.
3. For a secret, add its name to `secrets.required`, which you create if it's missing, describe
   it in `.dev.vars.example`, and give it a test value in `vitest.config.ts`.
4. Run `pnpm typegen`.
5. Set the production secret before the next deploy, because `wrangler deploy` fails while a
   required secret is missing. If `.dev.vars` holds the value, upload it yourself with
   `wrangler secret bulk`. Otherwise, ask the user to add it to `.dev.vars` first.
   [docs/deploy.md](docs/deploy.md) covers the upload and Preview secrets.

## Invariants

- Never log a token, secret, cookie, or other credential. Log an ID to say who made a request.
- pnpm refuses a dependency version that's younger than one day. To use one, commit its
  `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`, or pick an older version.

<!-- @starter:mcp -->

- `secrets.required` filters `.dev.vars`: only the listed keys load, and a `.dev.vars` entry
  can't override a `vars` value. Change local vars in `wrangler.jsonc`.
- `McpAgent` is deprecated and banned by oxlint. Serve MCP through `src/mcp/handler.ts`.
- Per-user KV keys start with `user:<id>:`, so they stay apart from every other record in the
  namespace.

<!-- @starter:end -->

<!-- @starter:oauth -->

- Auth handlers read the provider's helpers from `c.env.OAUTH_PROVIDER`, never from the `env` in
  `cloudflare:workers`, because the provider adds them only to the `env` of each request.
- The consent page lives in `src/auth/consent.ts` and renders with `hono/html`, which escapes
  every value. Keep it in `src/auth`.
- `MCP_RESOURCE` must equal the URL that clients use for `/mcp`, because every token is bound to
  it. Local requests and `workers.dev` Previews derive it from the request instead.
- An empty `ALLOWED_GITHUB_LOGINS` denies everyone. `*` admits every GitHub account.

<!-- @starter:end -->

<!-- @starter:web -->

- Identity goes through `src/http/access.ts`. `ctx.access` is absent behind the static assets
  router in production, so `access.ts` verifies the `Cf-Access-Jwt-Assertion` header itself.
  Don't read `ctx.access` anywhere else.

<!-- @starter:end -->

## Writing

Follow [docs/conventions.md](docs/conventions.md) for structure, comments, errors, logging, and
prose: a header comment in every source file, prose JSDoc without tags on exports, comments that
explain why, and the Google developer documentation style with no em dashes.

Topic guides:

- [docs/deploy.md](docs/deploy.md): secrets, Previews, the API token, and Renovate.
- [docs/testing.md](docs/testing.md): the test runtime and helpers.

<!-- @starter:mcp -->

- [docs/mcp.md](docs/mcp.md): tool design and a worked example.
- [docs/auth.md](docs/auth.md): how MCP clients authenticate.

<!-- @starter:end -->

<!-- @starter:web -->

- [docs/web.md](docs/web.md): the web app, identity, and the Cloudflare Access applications.

<!-- @starter:end -->
