# Deploy

This page covers how the Worker gets its secrets, how pull request Previews work, the GitHub
Actions setup, rollbacks, custom domains, the Cloudflare API token, Renovate, observability, and
the build output that Wrangler deploys.

## Build output

`pnpm build` runs the Vite build. The Cloudflare Vite plugin writes the deployable Worker, an
output `wrangler.json`, the static assets, and a redirect file, `.wrangler/deploy/config.json`,
that points at the output `wrangler.json`. `wrangler deploy` and `wrangler preview` follow the
redirect, so they deploy the last build. `wrangler types` reads the source `wrangler.jsonc`.

<!-- @starter:web -->

The Worker and its `wrangler.json` go to `build/server/`, and the static assets to `build/client/`.

<!-- @starter:end -->

Always build right before a deploy. A deploy after an edit to `wrangler.jsonc` without a new
build ships the old configuration. `pnpm run deploy`, `pnpm check:deploy`, and both workflows
build first.

`pnpm check:deploy` builds and runs `wrangler deploy --dry-run`, which validates the bundle and
the configuration without an account. It's the last step of `pnpm verify`.

## Worker secrets

List every secret that the Worker needs in `secrets.required` in `wrangler.jsonc`. The list does
three things:

- `wrangler dev` and `pnpm dev` load the listed keys from `.dev.vars`, plus any key named after a
  var, which overrides that var. They ignore every other key. This filter applies whenever
  `wrangler.jsonc` has a `secrets` block. Without one, they load every key.
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

The Worker's secrets live on the Worker, and GitHub holds the Cloudflare credentials.

<!-- @starter:mcp -->

GitHub can also hold Preview secrets, which a secrets step in the Preview workflow passes to
Previews.

<!-- @starter:end -->

## Previews

`.github/workflows/preview.yml` deploys a Worker Preview named `pr-<number>` for each pull request
from a branch in the same repository. Its URL is
`https://pr-<number>-<worker>.<subdomain>.workers.dev`. The workflow builds, runs
`wrangler preview --name pr-<number> --json`, and keeps only the JSON object from its output,
because Wrangler prints notices before it. Then it polls `/healthz` until it answers 200 with
`{"ok":true}`, and comments the URL on the pull request. Closing the pull request runs
`wrangler preview delete --name pr-<number> --skip-confirmation`.

Neither workflow's `/healthz` check follows redirects. The deploy workflow's check passes only on
that exact response, so a Cloudflare Access login fails it. The Preview workflow's check also
passes, with a notice, when Cloudflare Access answers instead of the Worker, because the workflow
can't sign in to Access. That Preview still gets its comment, but the check can't tell whether
the Preview serves traffic.

<!-- @starter:oauth -->

With GitHub OAuth, the workflow also checks that `POST /mcp` answers `401` with
`resource_metadata`, so MCP clients can find the sign-in flow.

<!-- @starter:end -->

Previews inherit nothing from production:

- **Vars and bindings:** the `previews` block in `wrangler.jsonc` declares them again. A binding
  that the code uses but the block lacks can fail the Preview with error 1101.
- **Secrets:** Previews never read production secrets, and `secrets.required` doesn't apply to
  them. A Preview keeps the secrets of its previous deployment, and a new Preview copies the
  Preview base config. Set the base config with `wrangler preview base-config secret put <KEY>` or
  `wrangler preview base-config secret bulk <file>`. A later change to it reaches only new
  Previews.

<!-- @starter:mcp -->

- **Secrets from GitHub:** the Preview workflow can also pass a secrets file with
  `--secrets-file`, holding each Preview secret set in GitHub.
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

In bearer mode, the Preview workflow has no step that writes the secrets file. To pass a Preview
token from GitHub, add a repository secret named `PREVIEW_MCP_BEARER_TOKEN` and add this step
before **Deploy the Preview**:

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

| Workflow      | Runs on                                                  | Does                                                                           |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ci.yml`      | Every pull request, and as the first job of `deploy.yml` | The jobs that its header comment lists, including `pnpm verify` and actionlint |
| `preview.yml` | Pull requests opened, updated, reopened, or closed       | Deploys, checks, and comments a Preview, and deletes it on close               |
| `deploy.yml`  | Push to `main`, or a manual run                          | CI, then `pnpm build` and `wrangler deploy`, then an optional health check     |

Nothing deploys until the repository variable `DEPLOY_ENABLED` is `true`. Until then, the deploy
and Preview jobs are skipped, so the template and a new project never deploy before their secrets
exist. Pull requests from forks never get a Preview, because their runs can't read secrets.

The workflows read these secrets and variables:

| Name                    | Kind     | Used by                     | Purpose                                                                                             |
| ----------------------- | -------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `DEPLOY_ENABLED`        | Variable | `deploy.yml`, `preview.yml` | Set to `true` to turn on deploys and Previews.                                                      |
| `CLOUDFLARE_API_TOKEN`  | Secret   | `deploy.yml`, `preview.yml` | The API token that Wrangler uses.                                                                   |
| `CLOUDFLARE_ACCOUNT_ID` | Secret   | `deploy.yml`, `preview.yml` | The account to deploy to.                                                                           |
| `HEALTHCHECK_URL`       | Variable | `deploy.yml`                | Optional. The Worker's base URL without a trailing slash. The job checks `/healthz` after a deploy. |

<!-- @starter:oauth -->

With GitHub OAuth, `preview.yml` also reads these optional secrets, and passes each one that's set
to Previews under the name in the second column. GitHub reserves the `GITHUB_` prefix for its own
secrets, which is why the Preview secrets carry a `PREVIEW_` prefix.

| Secret                         | Passed to Previews as  |
| ------------------------------ | ---------------------- |
| `PREVIEW_GITHUB_CLIENT_ID`     | `GITHUB_CLIENT_ID`     |
| `PREVIEW_GITHUB_CLIENT_SECRET` | `GITHUB_CLIENT_SECRET` |
| `PREVIEW_COOKIE_SECRET`        | `COOKIE_SECRET`        |

<!-- @starter:end -->

<!-- @starter:mcp -->

In bearer mode, the step that you add in [Bearer mode on Previews](#bearer-mode-on-previews)
reads the optional secret `PREVIEW_MCP_BEARER_TOKEN` and passes it as `MCP_BEARER_TOKEN`.

<!-- @starter:end -->

Set the secrets in the repository, or in the `production` and `preview` environments that the
deploy and Preview jobs use.

<!-- @starter:mcp -->

A Preview secret that isn't set in GitHub comes from the base config or from the previous
deployment of the same Preview.

<!-- @starter:end -->

## Roll back

`deploy.yml` tags each Worker version with the short SHA of the commit it deployed, so every
version maps to a commit. To return production to an earlier version, find its ID and roll back:

```sh
pnpm exec wrangler deployments list
pnpm exec wrangler versions list
pnpm exec wrangler rollback <version-id>
```

A rollback doesn't change `main`, so the next push to `main` deploys the current code again. To
keep the earlier code, revert the commit on `main`.

## Cloudflare API token

GitHub Actions deploys with an account-owned API token, scoped to the one account. The Cloudflare
CLI's login can't create tokens, so the person creates it. Setup presents it as a task with a
dashboard link that opens the **Account API Tokens** form with the permissions filled in:

```text
https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<permissions>&name=<name>%20GitHub%20Actions
```

`<permissions>` is the URL-encoded JSON list of the permissions in the table, such as
`[{"key":"workers_scripts","type":"edit"}]`. Cloudflare documents the format under
[API token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
The dashboard asks which account to use. The person scopes the token to that account, and the
Workers Routes permission to the custom domain's zone, then saves the token as the only contents
of `~/.config/setup-<owner>-<name>/cloudflare-api-token`, outside the repository. Setup verifies
the token with `GET /accounts/<account-id>/tokens/verify`, sets the `CLOUDFLARE_API_TOKEN`
repository secret from the file on standard input, and deletes the file when `finish` succeeds.

To create the token by hand, go to **Manage Account** > **Account API Tokens** and add these
permissions:

| Permission                                      | Why                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Account** > **Workers Scripts** > **Edit**    | Deploy the Worker, and create and delete its Previews.                                             |
| **Account** > **Workers KV Storage** > **Edit** | Only with a KV binding. Previews need edit access to the resources they use.                       |
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

<!-- @starter:oauth -->

`createMcpApiHandler()` in `src/mcp/handler.ts` checks the `Host` header only on `localhost` and
`workers.dev` by default. To apply the check on the custom domain, pass `allowedHostnames` where
the production handler is created: in `src/mcp/handler.ts` with GitHub OAuth, or in
`src/auth/bearer.ts` in bearer mode. Run `pnpm test` afterward, because the tests send requests
to `localhost`.

<!-- @starter:end -->

## Renovate

`renovate.json5` configures the Renovate GitHub app, and its comments explain each rule. Install
the app from <https://github.com/apps/renovate> on the repository. It's free for public and
private repositories.

Renovate's three-day wait exists because of pnpm's own minimum release age. pnpm 12 sets
`minimumReleaseAge` to 1440 minutes (one day) by default, in a non-strict mode that falls back to
a younger version when no older one matches. A frozen install, as in CI, rejects a lockfile entry
younger than the limit, so a version that installs locally can still fail CI. To allow one,
add it to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, such as `- wrangler@4.158.0`, and
remove the entry once that version is older than the limit.

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
- **KV and R2:** shared unless the `previews` block binds a different namespace or bucket.

Add each new binding to the [binding checklist](../AGENTS.md#add-a-binding-var-or-secret).
