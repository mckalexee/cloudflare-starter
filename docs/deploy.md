# Deploy

This page covers how the Worker gets its secrets, how pull request Previews work, the GitHub
Actions setup, custom domains, the Cloudflare API token, Renovate, observability, and the build
output that Wrangler deploys.

## Build output

`pnpm build` runs the Vite build. The Cloudflare Vite plugin writes the deployable Worker and an
output `wrangler.json` to `build/server/`, the static assets to `build/client/`, and a redirect
file, `.wrangler/deploy/config.json`, that points at `build/server/wrangler.json`. `wrangler
deploy` and `wrangler preview` follow the redirect, so they deploy the last build. `wrangler types`
reads the source `wrangler.jsonc`.

Always build right before a deploy. A deploy after an edit to `wrangler.jsonc` without a new
build ships the old configuration. `pnpm run deploy`, `pnpm check:deploy`, and both workflows
build first.

`pnpm check:deploy` builds and runs `wrangler deploy --dry-run`, which validates the bundle and
the configuration without an account. It's the last step of `pnpm verify`.

## Worker secrets

`secrets.required` in `wrangler.jsonc` lists the secrets that the Worker needs. It does three
things:

- `wrangler dev` and `pnpm dev` load only the listed keys from `.dev.vars`. Any other key in that
  file is ignored, and a `.dev.vars` entry can't override a var.
- `wrangler types` generates the secrets' types from the list, so type generation works in CI
  without a `.dev.vars` file.
- `wrangler deploy` fails while any listed secret is missing on the Worker.

Upload production secrets with `wrangler secret bulk`, which takes a JSON or dotenv file. Keep the
file outside the repository and delete it afterward:

```sh
pnpm exec wrangler secret bulk /path/to/secrets.env
```

If the Worker doesn't exist yet, `wrangler secret bulk` creates it. For one key, use
`pnpm exec wrangler secret put <KEY>`, which prompts for the value.

The Worker's secrets live on the Worker. GitHub holds only the Cloudflare credentials, and the
Preview secrets that the Preview workflow passes along.

## Previews

`.github/workflows/preview.yml` deploys a Worker Preview named `pr-<number>` for each pull request
from a branch in the same repository. Its URL is
`https://pr-<number>-<worker>.<subdomain>.workers.dev`. The workflow builds, runs
`wrangler preview --name pr-<number> --json`, polls `/healthz`, and comments the URL on the pull
request. Closing the pull request runs `wrangler preview delete --name pr-<number>
--skip-confirmation`.

<!-- @starter:oauth -->

With GitHub OAuth, the workflow also checks that `POST /mcp` answers `401` with
`resource_metadata`, so MCP clients can find the sign-in flow.

<!-- @starter:end -->

Previews inherit nothing from production:

- **Vars and bindings:** the `previews` block in `wrangler.jsonc` declares them again. A binding
  that the code uses but the block lacks can fail the Preview with error 1101.
- **Secrets:** Previews ignore `secrets.required` and never read production secrets. A Preview
  gets its secrets from three places:
  - The Preview base config, which every new Preview copies when it's created. Set it with
    `wrangler preview base-config secret put <KEY>` or `wrangler preview base-config secret bulk
    <file>`. A later change to the base config reaches only new Previews.
  - The workflow's secrets file, passed with `--secrets-file`, for each Preview secret set in
    GitHub.
  - The previous deployment of the same Preview.

<!-- @starter:mcp -->

- **KV:** `previews.kv_namespaces` binds a separate `OAUTH_KV` namespace, so Preview data never
  mixes with production. All Previews share that one namespace.

<!-- @starter:end -->

<!-- @starter:oauth -->

- **`MCP_RESOURCE`:** empty in `previews.vars`, so each Preview derives its resource URL from its
  own `workers.dev` hostname. [auth.md](auth.md#preview-callbacks) covers GitHub callbacks on
  Previews.

<!-- @starter:end -->

Cloudflare deletes the least recently deployed Preview when a Worker reaches its Preview limit,
and the oldest deployment when a Preview reaches its deployment limit.

<!-- @starter:mcp -->

### Bearer mode on Previews

In bearer mode, the Preview workflow has no step that writes the secrets file, because that step
maps the OAuth secrets. To pass a Preview token from GitHub, add a repository secret named
`PREVIEW_MCP_BEARER_TOKEN` and add this step before **Deploy the Preview**:

```yaml
- name: Write the Preview secrets file
  env:
    MCP_BEARER_TOKEN: ${{ secrets.PREVIEW_MCP_BEARER_TOKEN }}
  run: |
    umask 077
    : > "$RUNNER_TEMP/preview.env"
    if [ -n "$MCP_BEARER_TOKEN" ]; then
      printf 'MCP_BEARER_TOKEN=%s\n' "$MCP_BEARER_TOKEN" >> "$RUNNER_TEMP/preview.env"
    fi
```

The deploy step already passes the file when it isn't empty. Without the step, set the token once
in the base config with `wrangler preview base-config secret put MCP_BEARER_TOKEN`.

<!-- @starter:end -->

## GitHub Actions

| Workflow      | Runs on                                                  | Does                                                                                      |
| ------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ci.yml`      | Every pull request, and as the first job of `deploy.yml` | `pnpm verify`, the prune variants while the template's setup files remain, and actionlint |
| `preview.yml` | Pull requests opened, updated, reopened, or closed       | Deploys, checks, and comments a Preview, and deletes it on close                          |
| `deploy.yml`  | Push to `main`, or a manual run                          | CI, then `pnpm build` and `wrangler deploy`, then an optional health check                |

Nothing deploys until the repository variable `DEPLOY_ENABLED` is `true`. Until then, the deploy
and Preview jobs are skipped, so the template and a new project never deploy before their secrets
exist. Pull requests from forks never get a Preview, because their runs can't read secrets.

The workflows read these secrets and variables:

| Name                           | Kind     | Used by                     | Purpose                                                                                             |
| ------------------------------ | -------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `DEPLOY_ENABLED`               | Variable | `deploy.yml`, `preview.yml` | Set to `true` to turn on deploys and Previews.                                                      |
| `CLOUDFLARE_API_TOKEN`         | Secret   | `deploy.yml`, `preview.yml` | The API token that Wrangler uses.                                                                   |
| `CLOUDFLARE_ACCOUNT_ID`        | Secret   | `deploy.yml`, `preview.yml` | The account to deploy to.                                                                           |
| `HEALTHCHECK_URL`              | Variable | `deploy.yml`                | Optional. The Worker's base URL without a trailing slash. The job checks `/healthz` after a deploy. |
| `PREVIEW_GITHUB_CLIENT_ID`     | Secret   | `preview.yml`               | Optional. Passed to Previews as `GITHUB_CLIENT_ID`.                                                 |
| `PREVIEW_GITHUB_CLIENT_SECRET` | Secret   | `preview.yml`               | Optional. Passed to Previews as `GITHUB_CLIENT_SECRET`.                                             |
| `PREVIEW_COOKIE_SECRET`        | Secret   | `preview.yml`               | Optional. Passed to Previews as `COOKIE_SECRET`.                                                    |
| `PREVIEW_MCP_BEARER_TOKEN`     | Secret   | `preview.yml`, bearer mode  | Optional, after you add the Preview secrets step for bearer mode. Passed as `MCP_BEARER_TOKEN`.     |

GitHub reserves the `GITHUB_` prefix for its own secrets, which is why the Preview secrets carry
a `PREVIEW_` prefix. Set the secrets in the repository, or in the `production` and `preview`
environments that the deploy and Preview jobs use. A Preview secret that isn't set in GitHub
comes from the base config or from the previous deployment of the same Preview.

## Cloudflare API token

Create an account-owned token under **Manage Account** > **Account API Tokens**, scoped to the one
account, with these permissions:

| Permission                                      | Why                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Account** > **Workers Scripts** > **Edit**    | Deploy the Worker, and create and delete its Previews.                                             |
| **Account** > **Workers KV Storage** > **Edit** | MCP endpoint kept. Previews need edit access to the resources they use.                            |
| **Account** > **Account Settings** > **Read**   | The token that Cloudflare generates for Workers Builds includes it. Wrangler's docs don't list it. |
| **Zone** > **Workers Routes** > **Edit**        | Only with a custom domain, scoped to its zone, to attach the domain.                               |

The sources are Cloudflare's pages on
[Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/),
the [Previews examples](https://developers.cloudflare.com/workers/previews/examples/), which say
the token needs to edit Workers Scripts and the resources that the Preview uses, and the
[Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token),
which lists the permissions of the token that Workers Builds creates.

If the dashboard offers Workers roles instead, **Workers Scripts Edit** corresponds to the
**Editor** role at the Workers product scope. Editor can update and deploy a Worker but can't
create one, so the Worker must exist before CI's first deploy. Uploading the Worker's secrets
with `wrangler secret bulk` creates it. A project without secrets can run `pnpm run deploy` once
with your own login.

## Custom domains

To serve the Worker on a hostname in one of your zones:

1. In `wrangler.jsonc`, change `workers_dev` from `true` to `false`, uncomment `preview_urls` and
   `routes`, and set the route's `pattern` to your hostname:

   ```jsonc
   "workers_dev": false,
   "preview_urls": true,
   "routes": [{ "pattern": "tools.example.com", "custom_domain": true }],
   ```

   `preview_urls` keeps Previews on `workers.dev`, where the Preview workflow deploys them.

2. Give the API token **Zone** > **Workers Routes** > **Edit** on the zone.
3. Set the `HEALTHCHECK_URL` variable to `https://tools.example.com`.

<!-- @starter:oauth -->

With GitHub OAuth, also set `MCP_RESOURCE` in the top-level `vars` to
`https://tools.example.com/mcp`, and add `https://tools.example.com/callback` to the GitHub OAuth
app's callback URLs. With `workers_dev` off, the GitHub callback always arrives on the hostname
that you registered.

<!-- @starter:end -->

<!-- @starter:mcp -->

`createMcpApiHandler()` in `src/mcp/handler.ts` checks the `Host` header only on `localhost` and
`workers.dev` by default. To apply the check on the custom domain, pass `allowedHostnames` where
the production handler is created: in `src/mcp/handler.ts` with GitHub OAuth, or in
`src/auth/bearer.ts` in bearer mode. Run `pnpm test` afterward, because the tests send requests
to `localhost`.

<!-- @starter:end -->

## Renovate

`renovate.json5` configures the Renovate GitHub app, which is free for public and private
repositories. Install it from <https://github.com/apps/renovate> on the repository. Renovate then:

- Opens update pull requests before 6 AM on Mondays, at most five at a time, and refreshes the
  lockfile on the same schedule.
- Pins exact versions, matching the exact pins in `package.json`.
- Merges patch updates on its own once CI passes.
- Groups updates: `cloudflare` (`wrangler` and `@cloudflare/*`), `oxc` (`oxlint`, `oxfmt`, and
  `oxlint-tsgolint`), `mcp` (`agents` and `@modelcontextprotocol/*`), and `react-router`.
- Never merges the `mcp` group on its own, because `agents` requires an exact version of the MCP
  SDK and a person reviews each update.
- Keeps `@types/node` below 25, on the Node.js major in `.node-version`.
- Moves the action versions in `.github/workflows` through the `github-actions` manager that
  `config:recommended` turns on.

`minimumReleaseAge: "3 days"` makes Renovate wait three days after a release before it proposes
it. pnpm 12 also enforces a minimum release age: by default, `minimumReleaseAge` is 1440 minutes
(one day), in a non-strict mode that falls back to a younger version when no older one matches.
A frozen install, as in CI, rejects a lockfile entry younger than the limit. Renovate's longer
wait means an update pull request never asks pnpm for a version younger than its limit. `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` exempts a package, or one version
of it such as `- wrangler@4.158.0`, from the age check. Remove a version entry once that version
is older than the limit.

`pnpm-workspace.yaml` also holds `allowBuilds`, which decides whose install scripts run. It allows
`esbuild` and `workerd`, and sets `core-js-pure: false` to block that package's script.

## Observability

`wrangler.jsonc` turns on Workers observability:

- `observability.logs.enabled` sends every `console` line to Workers Logs. `src/lib/log.ts` writes
  one JSON object per line, so Workers Logs indexes the fields.
- `observability.traces.enabled` with `head_sampling_rate: 0.1` traces one request in ten.
- `upload_source_maps: true` maps stack traces in errors to the TypeScript source.

`pnpm tail` streams live logs from the deployed Worker.

## D1 and Durable Objects

The template doesn't use D1 or Durable Objects. If you add them, follow the Preview isolation
rules from Cloudflare's [Preview resources](https://developers.cloudflare.com/workers/previews/resources/)
page:

- **Durable Objects:** each Preview gets its own namespace and storage for a class that the same
  Worker defines, and that state is deleted with the Preview. Define the class and its migration,
  and declare the binding in `previews.durable_objects.bindings` too if code reads it from `env`,
  or the Preview can fail with error 1101.
- **D1:** Previews that bind the same `database_id` share rows. Bind Previews to a staging
  database under `previews.d1_databases`, and apply migrations to it once, because every Preview
  shares it.
- **KV and R2:** shared unless the `previews` block binds a different namespace or bucket, as this
  template does for `OAUTH_KV`.

Add each new binding to the [binding checklist](../AGENTS.md#add-a-binding-var-or-secret).
