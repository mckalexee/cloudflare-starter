# cloudflare-starter

A Cloudflare Worker with tests that run in workerd and GitHub Actions workflows for CI, pull
request Previews, and production deploys.

<!-- @starter:mcp -->

It serves a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server at `/mcp`.

<!-- @starter:end -->

<!-- @starter:oauth -->

MCP clients sign in with GitHub through OAuth.

<!-- @starter:end -->

<!-- @starter:web -->

It serves a server-rendered web app, which Cloudflare Access can make private.

<!-- @starter:end -->

To create a new project from this template, give a coding agent this prompt, and it follows the runbook in [SETUP.md](SETUP.md): "Set up a new project from the template at https://github.com/mckalexee/cloudflare-starter. Follow its SETUP.md from start to finish."

## What you get

<!-- @starter:mcp -->

**MCP endpoint.** `/mcp` runs the stateless `createMcpHandler` from `agents`, with two example
tools and a `defineTool` wrapper that sets annotations, checks scopes, and maps errors.

<!-- @starter:end -->

<!-- @starter:oauth -->

**OAuth.** An OAuth 2.1 authorization server in the same Worker, from
`@cloudflare/workers-oauth-provider`, handles discovery, dynamic client registration, Client ID
Metadata Documents, a consent page, and GitHub sign-in with an allowlist.

<!-- @starter:end -->

<!-- @starter:web -->

**Web app.** A React Router 8 app rendered on the server, behind Hono. Cloudflare Access identity
reaches loaders and API routes.

<!-- @starter:end -->

**Tooling.** Hono serves `/healthz` and maps errors to responses. Tests run in workerd, the same
runtime as production, with no network access. GitHub Actions run CI on every pull request, deploy
a Worker Preview per pull request, and deploy to production on every push to `main`. Renovate
groups and pins dependency updates.

## Stack

`package.json` pins the exact version of every package.

- **Runtime and CLI:** `wrangler`
- **HTTP:** `hono`
- **Build:** `vite`, `@cloudflare/vite-plugin`
- **Language:** `typescript`
- **Lint and format:** `oxlint`, `oxlint-tsgolint`, `oxfmt`
- **Tests:** `vitest`, `@cloudflare/vitest-plugin`, `@vitest/coverage-istanbul`
- **Network mocks:** `msw`, `@msw/cloudflare`
- **Tooling:** Node.js 24, pnpm 12

<!-- @starter:mcp -->

- **MCP:** `agents`, `@modelcontextprotocol/server`, `zod`

<!-- @starter:end -->

<!-- @starter:oauth -->

- **OAuth:** `@cloudflare/workers-oauth-provider`

<!-- @starter:end -->

<!-- @starter:web -->

- **Web app:** `react-router`, `react`, `react-dom`, `isbot`

<!-- @starter:end -->

<!-- @starter:access -->

- **Access tokens:** `jose`

<!-- @starter:end -->

## Run it locally

You need Node.js 24 and pnpm 12. Install the dependencies. The install also generates the
TypeScript types for the Worker.

```sh
pnpm install
```

<!-- @starter:oauth -->

For MCP sign-in, set up GitHub OAuth before you start the dev server:

1. Create your local secrets file from the example.

   ```sh
   cp .dev.vars.example .dev.vars
   ```

2. Fill in `.dev.vars`. `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` come from a GitHub OAuth app
   whose callback URLs include `http://localhost:5173/callback`. [docs/auth.md](docs/auth.md)
   describes the app. Generate `COOKIE_SECRET` with `openssl rand -hex 32`.

3. In `wrangler.jsonc`, set `ALLOWED_GITHUB_LOGINS` under `vars` to your GitHub login. The empty
   default admits no one. An `ALLOWED_GITHUB_LOGINS` entry in `.dev.vars` overrides it locally.

Without a GitHub OAuth app, everything except MCP sign-in works.

<!-- @starter:end -->

Start the dev server:

```sh
pnpm dev
```

The dev server listens on port 5173 and stops if another process holds that port. It serves:

- `http://localhost:5173/healthz`: the health check.

<!-- @starter:web -->

- `http://localhost:5173/`: the web app's home page.
- `http://localhost:5173/account`: the signed-in Access identity, or a public-mode note.
- `http://localhost:5173/api/me`: the same identity as JSON.

<!-- @starter:end -->

<!-- @starter:mcp -->

- `http://localhost:5173/mcp`: the MCP endpoint.

<!-- @starter:end -->

<!-- @starter:oauth -->

- `http://localhost:5173/.well-known/oauth-protected-resource/mcp`: protected resource metadata.
- `http://localhost:5173/.well-known/oauth-authorization-server`: authorization server metadata.

<!-- @starter:end -->

<!-- @starter:mcp -->

## Connect an MCP client

Use the URL of the deployed `/mcp` endpoint, such as `https://<host>/mcp`, or
`http://localhost:5173/mcp` for a client on your own machine.

<!-- @starter:end -->

<!-- @starter:oauth -->

Each client opens a browser for the consent page and the GitHub sign-in.

- **claude.ai and Claude Desktop:** go to **Settings** > **Connectors** > **Add custom
  connector**, and enter the URL. claude.ai connects from Anthropic's servers, so it needs a
  deployed URL, not `localhost`.
- **Claude Code:** add the server, then run `/mcp` in Claude Code to sign in.

  ```sh
  claude mcp add --transport http <name> https://<host>/mcp
  ```

- **MCP Inspector:** start it, choose the **Streamable HTTP** transport, and enter the URL.

  ```sh
  npx @modelcontextprotocol/inspector
  ```

<!-- @starter:end -->

<!-- @starter:mcp -->

To check the connection, call the `example_echo_message` tool.

<!-- @starter:end -->

## Deploy

CI runs `pnpm verify` on every pull request. Once the repository has its Cloudflare secrets and
the variable `DEPLOY_ENABLED` set to `true`, each pull request also gets a Worker Preview, and each
push to `main` deploys to production. To deploy by hand, run `pnpm run deploy`. The `run` is
required, because `pnpm deploy` is a built-in pnpm command.
[docs/deploy.md](docs/deploy.md) covers secrets, Previews, custom domains, and the API token.

## Documentation

- [AGENTS.md](AGENTS.md): commands, checklists, and invariants for changing the code. `CLAUDE.md`
  is a symlink to it.
- [docs/conventions.md](docs/conventions.md): the opinions on structure, naming, comments, errors,
  logging, dependencies, and writing style.
- [docs/deploy.md](docs/deploy.md): secrets, Previews, custom domains, Renovate, and observability.
- [docs/testing.md](docs/testing.md): how tests run in workerd and the test helpers.

<!-- @starter:mcp -->

- [docs/mcp.md](docs/mcp.md): tool design and how to add and test a tool.
- [docs/auth.md](docs/auth.md): how MCP clients authenticate.

<!-- @starter:end -->

<!-- @starter:web -->

- [docs/web.md](docs/web.md): the React Router app, identity in loaders, public mode, and the
  Cloudflare Access applications.

<!-- @starter:end -->

## License

This project is licensed under [MIT No Attribution (MIT-0)](LICENSE).
