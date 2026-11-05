# Set up a project from this template

This runbook is for a coding agent that starts in an empty folder with only a link to this
template. Follow it from top to bottom. It ends with a checklist that you report to the user.

The last step deletes this file. Copy the [report checklist](#report-to-the-user) into your notes
before you run that step.

## Rules for this runbook

- Ask the user the questions in [Collect the inputs](#collect-the-inputs) one at a time. Wait for
  each answer before you ask the next question. Skip a question when an earlier answer makes it
  irrelevant.
- Run each command from the project root unless a step says otherwise.
- The template marks code and documentation that belong to one half with marker comments that
  `scripts/prune.ts` removes. The comment at the top of that script describes the syntax. Don't
  edit or move the markers by hand.
- Never print a secret in your messages, and never ask the user to paste one into the
  conversation. Write secrets to files or pipe them to commands, and let the user type the
  secrets that only they have into a file or into a prompt in their own terminal.
- When a step fails and this runbook doesn't say what to do, stop and report the command, its
  output, and the step number to the user.

## Collect the inputs

Ask these questions in order:

1. **Project name.** Lowercase letters, digits, and hyphens, starting with a letter, at most 40
   characters, such as `acme-tools`. It names the GitHub repository, the Worker, and the KV
   namespaces. Preview hostnames prepend `pr-<number>-` to it, which is why it stays short.
2. **Display name.** The name people see, such as `Acme Tools`. It becomes `APP_NAME`. Suggest the
   project name in title case.
3. **GitHub owner.** The user or organization that owns the new repository. Suggest the owner of
   the GitHub account that `gh auth status` reports.
4. **Halves.** Which parts to keep: both the MCP endpoint and the web app, the MCP endpoint only,
   or the web app only.
5. **MCP sign-in mode** (MCP endpoint kept). GitHub OAuth, where each person signs in with their
   own GitHub account, or bearer mode, where one static bearer token serves a single user.
6. **Web access** (web app kept). Private behind Cloudflare Access, or public. For private, ask
   who may sign in: a list of email addresses, an email domain, or both.
7. **`workers.dev` subdomain and hostname.** First ask for the account's `workers.dev` subdomain,
   which the dashboard shows on the **Workers & Pages** overview page. Ask for it even when the
   user plans a custom domain and doesn't offer it, because Previews always run on `workers.dev`.
   Then ask for the hostname: the Worker's `workers.dev` hostname,
   `<name>.<subdomain>.workers.dev`, or a custom domain on a zone in the user's Cloudflare account,
   such as `tools.example.com`.
8. **Cloudflare account ID.** The dashboard shows it on the account home page and in the
   **Workers & Pages** sidebar.
9. **Allowed GitHub accounts** (GitHub OAuth). The GitHub logins or numeric user IDs that may sign
   in, separated by commas, or `*` for every GitHub account.
10. **OAuth on Previews** (GitHub OAuth). Whether pull request Previews should support MCP sign-in.
    It needs a second GitHub OAuth app with a wildcard callback. Without it, Previews still deploy
    and pass their checks, but sign-in on a Preview fails.

The user writes the GitHub OAuth app's client ID and secret into `.dev.vars` in step 11, and
creates the Cloudflare API token in step 14.

From the answers, pick the prune variant:

| Halves            | MCP sign-in mode | Prune commands                                                        |
| ----------------- | ---------------- | --------------------------------------------------------------------- |
| Both              | GitHub OAuth     | None now. Step 18 runs `--finish`.                                    |
| Both              | Bearer mode      | `node scripts/prune.ts bearer`                                        |
| MCP endpoint only | GitHub OAuth     | `node scripts/prune.ts mcp-only`                                      |
| MCP endpoint only | Bearer mode      | `node scripts/prune.ts mcp-only`, then `node scripts/prune.ts bearer` |
| Web app only      | Not applicable   | `node scripts/prune.ts app-only`                                      |

The steps use these placeholders:

- `<name>`: the project name.
- `<display-name>`: the display name.
- `<owner>`: the GitHub owner.
- `<subdomain>`: the account's `workers.dev` subdomain.
- `<host>`: the hostname.
- `<account-id>`: the Cloudflare account ID.

Have every answer, `<host>` included, before step 8, which writes `<host>` into `wrangler.jsonc`.

## Steps

### 1. Check the tools

```sh
node --version              # v24 or later
pnpm --version              # 12.x
gh auth status              # signed in to GitHub
rg --version
jq --version
openssl version
perl -e 'print "$^V\n"'     # step 3 uses Perl
```

If a tool is missing, ask the user to install it and stop until they confirm.

### 2. Create the repository

```sh
gh repo create <owner>/<name> --template mckalexee/cloudflare-starter --private --clone
cd <name>
git log --oneline -1
```

If `git log` reports that the branch has no commits, GitHub hadn't finished copying the template.
Run `git pull origin main`, then `git log --oneline -1` again. Retry the pull up to two times. If
the branch still has no commits, stop and report to the user.

### 3. Rename the project

Replace every occurrence of the template's name, except links to the template itself:

```sh
rg --hidden -l -g '!.git' -g '!SETUP.md' 'cloudflare-starter|Cloudflare Starter' \
  | xargs perl -pi -e 's{(?<!mckalexee/)cloudflare-starter}{<name>}g; s{Cloudflare Starter}{<display-name>}g'
```

Then confirm that nothing is left. This command must print nothing:

```sh
rg --hidden -g '!.git' -g '!SETUP.md' 'cloudflare-starter|Cloudflare Starter' \
  | rg -v 'mckalexee/cloudflare-starter'
```

### 4. Prune and install

Run the prune commands from the table in [Collect the inputs](#collect-the-inputs), then install:

```sh
node scripts/prune.ts <variant>
pnpm install
```

The script prints what it deleted and edited. If it prints `Nothing was changed.`, the template's
file list is stale. Stop and report the script's output to the user.

### 5. Confirm the Cloudflare login

```sh
pnpm exec wrangler whoami
```

If it reports that you aren't logged in, ask the user to run `pnpm exec wrangler login` in their
own terminal in the project folder, then run `wrangler whoami` again. If the account ID from the
inputs isn't in the output, stop and report to the user. The login belongs to another account.

Every later `wrangler` command in this runbook starts with `CLOUDFLARE_ACCOUNT_ID=<account-id>`, so
it can't act on another account.

### 6. Set the compatibility date

Set `compatibility_date` in `wrangler.jsonc` to today's date, which `date +%F` prints. If it
already equals `date +%F`, nothing changes.

### 7. Create the KV namespaces (MCP endpoint kept)

Production and Previews get separate namespaces, so Preview grants never reach production. Don't
pass `--preview`: that flag creates a namespace for `wrangler dev`, not for Worker Previews.

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler kv namespace create <name>-oauth
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler kv namespace create <name>-oauth-preview
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler kv namespace list \
  | jq -r '.[] | select(.title == "<name>-oauth" or .title == "<name>-oauth-preview") | "\(.title) \(.id)"'
```

In `wrangler.jsonc`, replace `REPLACE_WITH_KV_ID` with the ID of `<name>-oauth` and
`REPLACE_WITH_PREVIEW_KV_ID` with the ID of `<name>-oauth-preview`.

### 8. Set the vars

Edit `wrangler.jsonc`. Each var appears twice: under the top-level `vars` for production and
under `previews.vars` for Previews. Set both unless the list says otherwise.

#### MCP endpoint kept

- `APP_NAME`: step 3 already set it to the display name. Confirm both places.
- `MCP_RESOURCE` (GitHub OAuth): set the top-level value to `https://<host>/mcp`. Leave the
  `previews.vars` value empty, because each Preview derives its own.
- `ALLOWED_GITHUB_LOGINS` (GitHub OAuth): the allowed accounts from the inputs, in both places.
  Local sign-in needs it too, because `.dev.vars` can't override a var.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (private web app): leave them empty for now. Step 12 sets
  them.

#### Web app only

- `APP_NAME`: step 3 already set it to the display name. Confirm both places.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (private web app): leave them empty for now. Step 12 sets
  them.

A public web-app-only project changes no vars in this step.

### 9. Configure the custom domain (custom domain only)

In `wrangler.jsonc`, change `workers_dev` from `true` to `false`, uncomment the `preview_urls`
and `routes` lines, and set the route's `pattern` to `<host>`. The three lines then read:

```jsonc
"workers_dev": false,
"preview_urls": true,
"routes": [{ "pattern": "<host>", "custom_domain": true }],
```

`preview_urls` keeps Previews on `workers.dev`, where the Preview workflow deploys them. With
GitHub OAuth, turning off `workers.dev` also makes the GitHub callback always arrive on `<host>`,
the hostname that the OAuth app registers. The API token in step 14 also needs the Workers Routes
permission for the zone.

### 10. Create the GitHub OAuth app (GitHub OAuth)

GitHub has no API for creating OAuth apps, so the user creates the app in the browser. Send them
these instructions:

1. Go to <https://github.com/settings/applications/new>, or to the organization's
   **Settings** > **Developer settings** > **OAuth Apps** for an organization-owned app.
2. Set **Application name** to the display name and **Homepage URL** to `https://<host>`.
3. Add two callback URLs, with wildcard matching off for both:
   - `https://<host>/callback`
   - `http://localhost:5173/callback`
4. Register the app, then select **Generate a new client secret**.
5. Keep the client ID and the client secret for step 11. Don't paste them into the conversation.

If the user wants OAuth on Previews, ask for a second app, used only by Previews, with the
callback URL `https://<subdomain>.workers.dev/callback` and wildcard matching on. Tell the user
that wildcard matching lets any Worker on the account's `workers.dev` subdomain receive sign-in
codes for this app, which is why it's a separate app from production. Step 14 stores its values.
[docs/auth.md](docs/auth.md#preview-callbacks) explains the choice.

### 11. Create `.dev.vars`

For GitHub OAuth, create the file with a generated cookie secret and empty GitHub values:

```sh
cat > .dev.vars <<EOF
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
COOKIE_SECRET=$(openssl rand -hex 32)
EOF
```

Ask the user to open `.dev.vars` in an editor and fill in `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` with the production app's values. Then confirm that both are set without
printing them. This command prints `2`:

```sh
grep -cE '^GITHUB_CLIENT_(ID|SECRET)=.+' .dev.vars
```

For bearer mode, generate the token straight into the file:

```sh
echo "MCP_BEARER_TOKEN=$(openssl rand -hex 32)" > .dev.vars
```

Production uses the same token, and MCP clients send it as `Authorization: Bearer <token>`. Tell
the user that the token is in `.dev.vars` instead of printing it.

A web-app-only project has no secrets and skips this step.

### 12. Create the Cloudflare Access apps (private web app)

[docs/web.md](docs/web.md#cloudflare-access-applications) has the layouts and the API payloads.
Pick the layout:

- Web app only: the allow application on `<host>`, plus a bypass application on `/healthz` so
  the deploy workflow's health check reaches the Worker.
- Both halves: the allow application on `<host>`, plus the bypass application on `/healthz` and
  the MCP and OAuth paths, so MCP clients reach `/mcp` without an Access login.

The user can create the applications in the dashboard. To send the payloads through the API
instead, the user creates an API token with the **Access: Apps and Policies Write** permission.
The token never enters the conversation. Either the user exports it as `ACCESS_API_TOKEN` in the
shell that runs your commands, or the user runs the `curl` loop from `docs/web.md` in their own
terminal and tells you the `aud` values that it prints. Use the allowed emails or email domain
from the inputs in the allow policy. Create the bypass application first, so its paths are never
blocked.

Ask the user for the team domain, such as `myteam.cloudflareaccess.com`. The Zero Trust dashboard
shows it under **Settings** > **Team name and domain**.

Then set the vars in `wrangler.jsonc`, in both `vars` and `previews.vars`:

- `ACCESS_TEAM_DOMAIN`: the team domain.
- `ACCESS_AUD`: the allow application's Application Audience (AUD) tag, the `aud` field of the
  API response.

Previews don't match the hostname application, so private pages on a Preview answer 403 while
public pages and MCP keep working. [docs/web.md](docs/web.md#access-on-previews) describes how to
open private pages on Previews.

### 13. Verify locally

```sh
pnpm verify
```

If it fails right after a prune, the template's prune lists are stale. Report the failing check
and its output to the user, and don't patch around it. Fix any other failure that your own edits
caused, then run `pnpm verify` again.

To try the app, run `pnpm dev` and open `http://localhost:5173/healthz`. If the dev server
reports `Port 5173 is already in use`, ask the user to stop the process that holds the port.

### 14. Set up deployment

Which parts of this step apply depends on the halves:

- MCP endpoint kept: the Worker secrets for production and for Previews, the API token, and the
  GitHub secrets, variables, and environments.
- Web app only: creating the Worker, the API token, and the GitHub secrets, variables, and
  environments. `DEPLOY_ENABLED` and the `preview` environment apply to a web-app-only project
  too, because its pull requests get Previews of the web app.

#### Create the Worker (web app only)

The API token that CI uses can update a Worker but might not be allowed to create one, so create
it with your own login:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`, which is a built-in pnpm command.

#### Worker secrets for production (MCP endpoint kept)

The first upload creates the Worker, so CI's first deploy only updates it. Build a secrets file
from `.dev.vars` outside the repository, upload it, and delete it.

For GitHub OAuth, copy the GitHub values and generate a production cookie secret instead of
reusing the local one:

```sh
secrets_file=$(mktemp)
grep -E '^GITHUB_CLIENT_(ID|SECRET)=' .dev.vars > "$secrets_file"
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> "$secrets_file"
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler secret bulk "$secrets_file"
rm "$secrets_file"
```

For bearer mode, copy the token:

```sh
secrets_file=$(mktemp)
grep '^MCP_BEARER_TOKEN=' .dev.vars > "$secrets_file"
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler secret bulk "$secrets_file"
rm "$secrets_file"
```

#### Worker secrets for Previews (MCP endpoint kept)

Previews don't read production secrets. Each new Preview copies the Preview base config.

With OAuth on Previews, ask the user to store the Preview app's values from their own terminal in
the project folder. Each command prompts for the value:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler preview base-config secret put GITHUB_CLIENT_ID
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler preview base-config secret put GITHUB_CLIENT_SECRET
```

Then generate the Preview cookie secret yourself:

```sh
secrets_file=$(mktemp)
echo "COOKIE_SECRET=$(openssl rand -hex 32)" > "$secrets_file"
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler preview base-config secret bulk "$secrets_file"
rm "$secrets_file"
```

Without OAuth on Previews, skip this part.

For bearer mode, store the token in the base config so that MCP works on Previews. Use the same
`grep` file as for production, with `wrangler preview base-config secret bulk`.

#### Cloudflare API token for GitHub Actions

Ask the user to create an account-owned API token in the dashboard under **Manage Account** >
**Account API Tokens**, scoped to this account, with these permissions:

- **Account** > **Workers Scripts** > **Edit**
- **Account** > **Workers KV Storage** > **Edit** (MCP endpoint kept)
- **Account** > **Account Settings** > **Read**
- **Zone** > **Workers Routes** > **Edit**, for the custom domain's zone only

[docs/deploy.md](docs/deploy.md#cloudflare-api-token) explains each permission.

#### GitHub secrets, variables, and environments

Ask the user to run these in their own terminal from the project folder, so the token never
appears in your conversation. Each command prompts for the value:

```sh
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

The `production` and `preview` environments are optional. Create them:

```sh
gh api --method PUT repos/<owner>/<name>/environments/production
gh api --method PUT repos/<owner>/<name>/environments/preview
```

If creating them fails because the account's plan doesn't include environments for private
repositories, skip them and continue. The workflows still run with the repository secrets.

Then set the variables:

```sh
gh variable set HEALTHCHECK_URL --body "https://<host>"
gh variable set DEPLOY_ENABLED --body true
```

Confirm with `gh secret list` that both secrets exist before you continue.

### 15. Push and check the deployment

```sh
git add -A
git commit -m "Set up <name> from the template"
git push origin main
gh run list --workflow deploy.yml --limit 1 --json databaseId,headSha,status
gh run watch <run-id> --exit-status
```

The run's `headSha` must equal the output of `git rev-parse HEAD`. If the list doesn't show the
new run yet, wait a few seconds and list again.

If the deploy job fails with a missing secret, the log names it. Ask the user to add it, then
rerun with `gh run rerun <run-id> --failed`.

When the run succeeds, check the live Worker:

```sh
curl -fsS https://<host>/healthz
```

It returns `{"ok":true}`. With GitHub OAuth, also check sign-in discovery:

```sh
curl -sS -o /dev/null -D - -X POST -H 'content-type: application/json' --data '{}' https://<host>/mcp
curl -fsS https://<host>/.well-known/oauth-protected-resource/mcp
curl -fsS https://<host>/.well-known/oauth-authorization-server
```

- The `POST /mcp` response is `401` with a `www-authenticate` header that contains
  `resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`.
- The protected resource metadata has `"resource":"https://<host>/mcp"`. If it names another URL,
  `MCP_RESOURCE` is wrong.
- The authorization server metadata has `"issuer":"https://<host>"`.

In bearer mode, `POST /mcp` without a token answers `401` with `WWW-Authenticate: Bearer`, and
the two `.well-known` URLs don't exist.

For a private web app, open `https://<host>/account` in a browser. Access asks you to sign in,
and the page then shows your email.

### 16. Connect Claude

With GitHub OAuth, ask the user to add `https://<host>/mcp` as a custom connector in claude.ai
(**Settings** > **Connectors** > **Add custom connector**), sign in, and ask Claude to call
`example_echo_message`. For Claude Code, the command is:

```sh
claude mcp add --transport http <name> https://<host>/mcp
```

In bearer mode, use a client that sends a fixed header, such as Claude Code:

```sh
claude mcp add --transport http <name> https://<host>/mcp --header "Authorization: Bearer <token>"
```

The tool returns the message it was sent. If sign-in ends with `access_denied`, the GitHub
account isn't in `ALLOWED_GITHUB_LOGINS`. A web-app-only project skips this step.

### 17. Turn on Renovate

Ask the user to install the Renovate GitHub app from <https://github.com/apps/renovate> and grant
it access to `<owner>/<name>`. Renovate reads `renovate.json5` and opens its first update pull
requests on its weekly schedule.

### 18. Finish

The template's `LICENSE` is MIT No Attribution (MIT-0). Ask the user whether the new project keeps
it or replaces it with another license, and make that change before you commit.

```sh
node scripts/prune.ts --finish
pnpm install
pnpm verify
git add -A
git commit -m "Remove the template setup files"
git push origin main
```

`--finish` removes the remaining marker comments, the CI job that tests the prune script, the
script itself, and this file. It also rewrites the `Halves present:` line in `AGENTS.md` to match
what you kept. If it refuses because a file still mentions a marker, remove that mention and run
it again.

## Report to the user

Report each item as done, skipped with the reason, or failed with the error:

- Repository: `https://github.com/<owner>/<name>`, private, created from the template.
- Halves kept and the prune commands run.
- MCP sign-in mode, the allowed GitHub accounts, and whether Previews support OAuth.
- Web access: public, or private with the Access app names and who may sign in.
- Hostname and the MCP URL, `https://<host>/mcp`.
- KV namespace IDs for production and Previews.
- Worker secrets set for production, and for Previews if any.
- GitHub secrets, variables, and environments created.
- Result of `pnpm verify` after the last change.
- The deploy run's URL and its result.
- Results of the `/healthz`, `POST /mcp`, and `.well-known` checks.
- Whether the user connected Claude and `example_echo_message` worked.
- Whether Renovate is installed.
- Whether the project kept the MIT-0 license or replaced it.
- Whether `--finish` ran and the final commit is pushed.
- Anything that failed or that the user still needs to do.
