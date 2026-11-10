# Set up a project from this template

This runbook is for a coding agent that starts in an empty folder with only a link to this
template. Follow it from top to bottom. It ends with a checklist that you report to the user.

The last step deletes this file. Copy the [report checklist](#report-to-the-user) into your notes
before you run that step.

## What finished means

The setup is finished when all of these are true:

- The Worker is deployed, and `https://<host>/healthz` answers.
- The sign-in checks in step 14 pass.
- Every change is committed and pushed to `main`, and the working tree is clean.
- The user has the [report](#report-to-the-user).

Don't end the run before that. If a task that only the user can do is still open, finish every
step that doesn't wait on it, commit and push, and then ask for that one task.

## Rules for this runbook

- **The user has approved every action in this runbook.** A user who gives you this runbook asks
  for all of it: creating the repository, committing and pushing to `main`, creating Cloudflare
  resources, uploading secrets, and deploying. Don't ask for approval again before a step, and
  don't hand a step to the user because it changes something outside the project folder. The
  rule in `AGENTS.md` against deploying without a request doesn't apply to this runbook, because
  the runbook is the request.
- **Set up first, build second.** If the user's request also says what the project does, such as
  the tools it needs, finish this runbook with the template's example code first. Start the
  project's own work after the report, when every push to `main` deploys. The setup depends on
  none of the product decisions, and a half-built product can't be deployed or checked.
- **Look up before you ask.** Answer a question yourself when `gh`, `wrangler`, or a Cloudflare
  tool that you have can answer it, and tell the user the value that you found. Ask only for
  what you can't find.
- Ask the remaining questions in [Collect the inputs](#collect-the-inputs) one at a time. Wait
  for each answer before you ask the next question. Skip a question when an earlier answer makes
  it irrelevant.
- **Give the user one task at a time.** Step 3 holds the tasks that only the user can do. Send
  each task as its own message that holds nothing else: what to do, click by click, and what to
  answer when it's done. End your turn after that message, because the user might not see text
  that you write between commands. When the user answers, run the task's check, and send the
  next task only after the check passes. Never put a task inside a status report.
- **Commit as you go.** Commit and push at the points that the steps name. A push to `main`
  doesn't deploy until step 14 sets `DEPLOY_ENABLED`.
- **Keep the run small.** The setup is about 60 commands. Don't read the template's source or
  its other documentation unless a step names the file.
- Run each command from the project root unless a step says otherwise.
- The template marks code and documentation that belong to one half with marker comments that
  `scripts/prune.ts` removes. The comment at the top of that script describes the syntax. Don't
  edit or move the markers by hand.
- Never print a secret in your messages, and never ask the user to paste one into the
  conversation. Write secrets to files or pipe them to commands, and let the user type the
  secrets that only they have into a file or into a prompt in their own terminal.
- **Fix what you can, and stop only for the user's decisions.** When a step fails, read the
  error and fix the cause when it's within your reach: a port in use, a DNS answer that your
  machine cached, a date that the installed tools don't support yet, or a stale list in the
  template. Note each template problem for the report. Stop only when the fix needs a decision
  or an access that belongs to the user. Then commit and push what you have, and report the
  command, its output, and the step number.

## Collect the inputs

Work through these inputs in order:

1. **Project name.** Lowercase letters, digits, and hyphens, starting with a letter, at most 40
   characters, such as `acme-tools`. It names the GitHub repository, the Worker, and the KV
   namespaces. Preview hostnames prepend `pr-<number>-` to it, which is why it stays short.
2. **Display name.** The name people see, such as `Acme Tools`. It becomes `APP_NAME`. Suggest the
   project name in title case.
3. **Description** (optional). One sentence that says what the project does, such as
   `Tracks support requests for the Acme team.` Step 2 sets it as the repository description, and
   step 4 puts it in the MCP server's instructions. If the user doesn't give one, skip both uses.
4. **GitHub owner.** The user or organization that owns the new repository. Suggest the owner of
   the GitHub account that `gh auth status` reports.
5. **Halves.** Which parts to keep: both the MCP endpoint and the web app, the MCP endpoint only,
   or the web app only.
6. **MCP sign-in mode** (MCP endpoint kept). GitHub OAuth, where each person signs in with their
   own GitHub account, or bearer mode, where one static bearer token serves a single user.
7. **Web access** (web app kept). Private behind Cloudflare Access, or public. For private, ask
   who may sign in: a list of email addresses, an email domain, or both.
8. **`workers.dev` subdomain and hostname.** First ask for the account's `workers.dev` subdomain,
   which the dashboard shows on the **Workers & Pages** overview page. Ask for it even when the
   user plans a custom domain and doesn't offer it, because Previews always run on `workers.dev`.
   With a Cloudflare API tool, look it up instead: `GET /accounts/<account-id>/workers/subdomain`
   returns it.
   Then ask for the hostname: the Worker's `workers.dev` hostname,
   `<name>.<subdomain>.workers.dev`, or a custom domain on a zone in the user's Cloudflare account,
   such as `tools.example.com`.

   If the user keeps both halves and wants a private web app, reject the `workers.dev` hostname
   and tell the user why: Worker-level Access would block `/mcp`, so that combination needs a
   custom domain or a public web app. Then ask for a custom domain, or ask question 7 again.

9. **Cloudflare account ID.** Look it up: `pnpm dlx wrangler whoami` lists the accounts of the
   Wrangler login. Ask only when it lists more than one account or reports that you aren't
   logged in. The dashboard shows the ID on the account home page and in the **Workers & Pages**
   sidebar.
10. **Allowed GitHub accounts** (GitHub OAuth). The GitHub logins or numeric user IDs that may
    sign in, separated by commas, or `*` for every GitHub account.
11. **OAuth on Previews** (GitHub OAuth). Whether pull request Previews should support MCP sign-in.
    It needs a second GitHub OAuth app with a wildcard callback. Without it, Previews still deploy
    and pass their checks, but sign-in on a Preview fails.
12. **Zero Trust team domain** (private web app). Such as `myteam.cloudflareaccess.com`. The Zero
    Trust dashboard shows it under **Settings** > **Team name and domain**.
13. **Project secrets** (optional). The names of the credentials that the project's own code
    will need, such as the API key of a service that it calls. Take them from the user's request,
    and ask only when the request leaves it unclear. You need the names here, never the values.
    Step 3 has the user fill them in together with the other secrets, so the product work
    doesn't wait for them later. The setup itself doesn't use them.
14. **License.** The template's `LICENSE` is MIT No Attribution (MIT-0). Ask whether the project
    keeps it or replaces it with another license. Step 16 makes the change.

Step 3 gives the user every task that only they can do, such as creating the GitHub OAuth app
and the Cloudflare API token.

From the answers, pick the prune variant:

| Halves            | MCP sign-in mode | Prune commands                                                        |
| ----------------- | ---------------- | --------------------------------------------------------------------- |
| Both              | GitHub OAuth     | None now. Step 16 runs `--finish`.                                    |
| Both              | Bearer mode      | `node scripts/prune.ts bearer`                                        |
| MCP endpoint only | GitHub OAuth     | `node scripts/prune.ts mcp-only`                                      |
| MCP endpoint only | Bearer mode      | `node scripts/prune.ts mcp-only`, then `node scripts/prune.ts bearer` |
| Web app only      | Not applicable   | `node scripts/prune.ts app-only`                                      |

The steps use these placeholders:

- `<name>`: the project name.
- `<display-name>`: the display name.
- `<description>`: the description, if the user gave one.
- `<owner>`: the GitHub owner.
- `<subdomain>`: the account's `workers.dev` subdomain.
- `<host>`: the hostname.
- `<account-id>`: the Cloudflare account ID.

Have every answer, `<host>` included, before step 9, which writes `<host>` into `wrangler.jsonc`.

## Steps

### 1. Check the tools

```sh
node --version              # v24 or later
pnpm --version              # 12.x
gh auth status              # signed in to GitHub
rg --version
jq --version
openssl version
perl -e 'print "$^V\n"'     # step 4 uses Perl
```

If a tool is missing, ask the user to install it and stop until they confirm.

### 2. Create the repository

```sh
gh repo create <owner>/<name> --template mckalexee/cloudflare-starter --private --clone \
  --description "<description>"
cd <name>
git log --oneline -1
```

If the user gave no description, leave out `--description`.

If `git log` reports that the branch has no commits, GitHub hadn't finished copying the template.
Run `git pull origin main`, then `git log --oneline -1` again. Retry the pull up to two times. If
the branch still has no commits, stop and report to the user.

### 3. Hand the user their tasks

Every task that only the user can do is in this step, so that the rest of the runbook runs
without them. Follow the one-task rule in [Rules for this runbook](#rules-for-this-runbook): send
one task, end your turn, run its check when the user answers, and then send the next task. Skip a
task that doesn't apply. Each task says what waits on it. If the user wants to do a task later,
continue with the steps that don't wait on it.

Before the first task, create `.dev.vars`, which Git ignores.

For GitHub OAuth, create the file with a generated cookie secret and empty GitHub values:

```sh
cat > .dev.vars <<EOF
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
COOKIE_SECRET=$(openssl rand -hex 32)
EOF
```

For bearer mode, generate the token straight into the file:

```sh
echo "MCP_BEARER_TOKEN=$(openssl rand -hex 32)" > .dev.vars
```

Production uses the same token, and MCP clients send it as `Authorization: Bearer <token>`. Tell
the user that the token is in `.dev.vars` instead of printing it.

If the inputs name project secrets, append each name with an empty value:

```sh
echo "<SECRET_NAME>=" >> .dev.vars
```

A web-app-only project with no project secrets has no `.dev.vars`.

#### Task: GitHub OAuth app (GitHub OAuth)

GitHub has no API for creating OAuth apps, so the user creates the app in the browser. Send them
these instructions:

1. Go to <https://github.com/settings/applications/new>, or to the organization's
   **Settings** > **Developer settings** > **OAuth Apps** for an organization-owned app.
2. Set **Application name** to the display name and **Homepage URL** to `https://<host>`.
3. Add two callback URLs, with wildcard matching off for both:
   - `https://<host>/callback`
   - `http://localhost:5173/callback`
4. Register the app, then select **Generate a new client secret**.
5. Open `.dev.vars` in the project folder in an editor, and fill in `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`. Don't paste them into the conversation.

Check: this command prints `2`, without printing the values.

```sh
grep -cE '^GITHUB_CLIENT_(ID|SECRET)=.+' .dev.vars
```

Waits on it: step 13 and every step after it, because `wrangler deploy` fails while a required
secret is missing. If the user puts this task off, run through step 12 and stop there.

If the user wants OAuth on Previews, add two more keys to `.dev.vars` and ask for a second app,
used only by Previews, with the callback URL `https://<subdomain>.workers.dev/callback` and
wildcard matching on:

```sh
printf 'PREVIEW_GITHUB_CLIENT_ID=\nPREVIEW_GITHUB_CLIENT_SECRET=\n' >> .dev.vars
```

The user fills in both keys with the second app's values. The Worker ignores them, because it
loads only the keys in `secrets.required`, and step 13 uploads them to the Preview base config.
Tell the user that wildcard matching lets any Worker on the account's `workers.dev` subdomain
receive sign-in codes for this app, which is why it's a separate app from production.
[docs/auth.md](docs/auth.md#preview-callbacks) explains the choice. With the second app, the
check prints `4`:

```sh
grep -cE '^(PREVIEW_)?GITHUB_CLIENT_(ID|SECRET)=.+' .dev.vars
```

#### Task: project secrets (project secrets named)

Ask the user to fill in the empty project keys in `.dev.vars`. Say where each value comes from if
you know it, such as the service's developer page.

Check: this command prints `0`, the number of keys that are still empty.

```sh
grep -cE '^[A-Za-z0-9_]+=$' .dev.vars
```

Waits on it: nothing in this runbook. The product work needs the values.

#### Task: Cloudflare API token for GitHub Actions

Ask the user to create an account-owned API token in the dashboard under **Manage Account** >
**Account API Tokens**, scoped to this account, with these permissions:

- **Account** > **Workers Scripts** > **Edit**
- **Account** > **Workers KV Storage** > **Edit** (MCP endpoint kept)
- **Account** > **Account Settings** > **Read**
- **Zone** > **Workers Routes** > **Edit**, for the custom domain's zone only

[docs/deploy.md](docs/deploy.md#cloudflare-api-token) explains each permission.

Then ask the user to run this in their own terminal from the project folder, so the token never
appears in your conversation. The command prompts for the value:

```sh
gh secret set CLOUDFLARE_API_TOKEN
```

Check: `gh secret list` shows `CLOUDFLARE_API_TOKEN`.

Waits on it: deploys from GitHub Actions and pull request Previews. Without the token, step 14
deploys from your machine with the Wrangler login, and the report lists this task as open.

#### Task: Access API token (private web app on a custom domain)

Skip this task if you have a Cloudflare tool that can create Access applications, or if the user
prefers to create the applications in the dashboard during step 11.

Create an empty file outside the project folder, and give the user its path:

```sh
mktemp
```

Ask the user to create an API token with the **Access: Apps and Policies Write** permission and
to save it as the only line of that file.

Check: `test -s <token-file>` succeeds.

Waits on it: step 11, which reads the token from the file and then deletes the file.

#### Task: Renovate

Ask the user to install the Renovate GitHub app from <https://github.com/apps/renovate> and grant
it access to `<owner>/<name>`. Renovate reads `renovate.json5` and opens its first update pull
requests on its weekly schedule.

Nothing waits on it, and it has no check. Report the user's answer.

After the last task, the runbook needs the user again only in step 15.

### 4. Rename the project

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

If the project keeps the MCP endpoint and the user gave a description, open
`src/mcp/instructions.ts` and replace the first sentence of `INSTRUCTIONS`,
`This server is a starting point for an MCP server on Cloudflare Workers.`, with a sentence built
from the description, such as `This server tracks support requests for the Acme team.` Keep the
rest of the text as it is.

### 5. Prune and install

Run the prune commands from the table in [Collect the inputs](#collect-the-inputs), then install:

```sh
node scripts/prune.ts <variant>
pnpm install
```

The script prints what it deleted and edited. If it prints `Nothing was changed.`, the template's
file list is stale. Stop and report the script's output to the user.

### 6. Confirm the Cloudflare login

```sh
pnpm exec wrangler whoami
```

If it reports that you aren't logged in, ask the user to run `pnpm exec wrangler login` in their
own terminal in the project folder, then run `wrangler whoami` again. If the account ID from the
inputs isn't in the output, stop and report to the user. The login belongs to another account.

Every later `wrangler` command in this runbook starts with `CLOUDFLARE_ACCOUNT_ID=<account-id>`, so
it can't act on another account.

### 7. Set the compatibility date

Set `compatibility_date` in `wrangler.jsonc` to today's date, which `date +%F` prints. If it
already equals `date +%F`, nothing changes.

The installed `workerd` can be a few days older than today. If `pnpm verify` or `pnpm dev` later
rejects the date, the error names the newest date that `workerd` supports. Set that date.

### 8. Create the KV namespaces (MCP endpoint kept)

The `OAUTH_KV` binding holds the MCP tools' state and, with GitHub OAuth, the OAuth grants and
tokens. Production and Previews get separate namespaces, so Preview data never reaches
production. Don't pass `--preview`: that flag creates a namespace for `wrangler dev`, not for
Worker Previews.

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler kv namespace create <name>-kv
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler kv namespace create <name>-kv-preview
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler kv namespace list \
  | jq -r '.[] | select(.title == "<name>-kv" or .title == "<name>-kv-preview") | "\(.title) \(.id)"'
```

In `wrangler.jsonc`, replace `REPLACE_WITH_KV_ID` with the ID of `<name>-kv` and
`REPLACE_WITH_PREVIEW_KV_ID` with the ID of `<name>-kv-preview`.

### 9. Set the vars

Edit `wrangler.jsonc`. Each var appears twice: under the top-level `vars` for production and
under `previews.vars` for Previews. Set both unless the list says otherwise.

#### MCP endpoint kept

- `APP_NAME`: step 4 already set it to the display name. Confirm both places.
- `MCP_RESOURCE` (GitHub OAuth): set the top-level value to `https://<host>/mcp`. Leave the
  `previews.vars` value empty, because each Preview derives its own.
- `ALLOWED_GITHUB_LOGINS` (GitHub OAuth): the allowed accounts from the inputs, in both places.
  Local sign-in needs it too, because `.dev.vars` can't override a var.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (private web app): leave them empty for now. Step 11 sets
  them.

#### Web app only

- `APP_NAME`: step 4 already set it to the display name. Confirm both places.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (private web app): leave them empty for now. Step 11 sets
  them on a custom domain, and step 13 on `workers.dev`.

A public web-app-only project changes no vars in this step.

### 10. Configure the custom domain (custom domain only)

In `wrangler.jsonc`, change `workers_dev` from `true` to `false`, uncomment the `preview_urls`
and `routes` lines, and set the route's `pattern` to `<host>`. The three lines then read:

```jsonc
"workers_dev": false,
"preview_urls": true,
"routes": [{ "pattern": "<host>", "custom_domain": true }],
```

`preview_urls` keeps Previews on `workers.dev`, where the Preview workflow deploys them. With
GitHub OAuth, turning off `workers.dev` also makes the GitHub callback always arrive on `<host>`,
the hostname that the OAuth app registers. The API token from step 3 also needs the Workers Routes
permission for the zone.

### 11. Create the Cloudflare Access apps (private web app)

Use the team domain from the inputs.

#### Custom domain

[docs/web.md](docs/web.md#cloudflare-access-applications) has the layouts and the API payloads.
Pick the layout:

- Web app only: the allow application on `<host>`, plus a bypass application on `/healthz` so
  the deploy workflow's health check reaches the Worker.
- Both halves: the allow application on `<host>`, plus the bypass application on `/healthz` and
  the MCP and OAuth paths, so MCP clients reach `/mcp` without an Access login.

Use the allowed emails or email domain from the inputs in the allow policy. Create the bypass
application first, so its paths are never blocked. Create the applications in one of three ways:

- **A Cloudflare tool that you have.** If it can create Access applications, send the payloads
  yourself.
- **The Access API token from step 3.** Write the payload files to a temporary directory from
  `mktemp -d`, never to the project folder, because the project folder is committed and the allow
  policy holds email addresses. Run the `curl` loop from `docs/web.md` with
  `ACCESS_API_TOKEN="$(cat <token-file>)"` set in the same command, so the token is never
  printed. Then delete the token file.
- **The dashboard.** If the user chose it, send the two layouts as one task, as in step 3, and
  ask for the allow application's Application Audience (AUD) tag.

Then set the vars in `wrangler.jsonc`, in both `vars` and `previews.vars`:

- `ACCESS_TEAM_DOMAIN`: the team domain.
- `ACCESS_AUD`: the allow application's Application Audience (AUD) tag, the `aud` field of the
  API response.

Previews don't match the hostname application, so private pages on a Preview answer 403 while
public pages and MCP keep working. [docs/web.md](docs/web.md#access-on-previews) describes how to
open private pages on Previews.

#### `workers.dev` hostname (web app only)

A self-hosted application needs a hostname on a zone in the user's account, so protect the
Worker itself instead, as [docs/web.md](docs/web.md#web-app-only) describes. The Worker doesn't
exist until step 13 creates it, so step 13 turns on Access and sets the vars. Keep the team
domain for that step.

### 12. Verify locally

```sh
pnpm verify
```

Fix a failure that your own edits caused, then run `pnpm verify` again. If it fails right after a
prune and none of your edits are involved, the template's prune lists are stale. Fix the leftover
in the new project, and note the failing check for the report, so that the user can fix the
template.

To try the app, run `pnpm dev` and request `http://localhost:5173/healthz`. If the dev server
reports `Port 5173 is already in use`, another program holds the port. Leave that program alone,
and start the server on a free port:

```sh
pnpm exec vite dev --port 5199
```

Stop the dev server when the check is done. Then commit and push:

```sh
git add -A
git commit -m "Set up <name> from the template"
git push origin main
```

The push starts the deploy workflow. It runs CI and skips the deploy job, because
`DEPLOY_ENABLED` isn't set yet.

### 13. Set up deployment

Which parts of this step apply depends on the halves:

- MCP endpoint kept: the Worker secrets for production and for Previews, and the GitHub secret,
  variable, and environments.
- Web app only: creating the Worker, Worker-level Access for a private web app on `workers.dev`,
  and the GitHub secret, variable, and environments. The `preview` environment applies to a
  web-app-only project too, because its pull requests get Previews of the web app.

#### Create the Worker (web app only)

The API token that CI uses can update a Worker but might not be allowed to create one, so create
it with your own login:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`, which is a built-in pnpm command.

#### Turn on Access for the Worker (private web app on `workers.dev`)

This task needs the Worker, so it can't be part of step 3. Send it as its own message, as in
step 3. Ask the user to protect the Worker from **Workers & Pages** > `<name>` > **Access**, with
a policy that allows the emails or email domain from the inputs. The Access application covers every path
on the Worker's hostnames and its Previews. Then ask the user for that application's Application
Audience (AUD) tag, which the dashboard lists under **Zero Trust** > **Access controls** >
**Applications**.

Set the vars in `wrangler.jsonc`, in both `vars` and `previews.vars`:

- `ACCESS_TEAM_DOMAIN`: the team domain from the inputs.
- `ACCESS_AUD`: the AUD tag.

Until step 14 deploys these vars, the Worker treats the site as public, and Access alone guards
it.

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

If a project secret from the inputs is already in `secrets.required`, add its line from
`.dev.vars` to the same file before you upload it.

#### Worker secrets for Previews (MCP endpoint kept)

Previews don't read production secrets. Each new Preview copies the Preview base config.

With OAuth on Previews, copy the Preview app's values from `.dev.vars` under the names that the
Worker reads, and generate the Preview cookie secret:

```sh
secrets_file=$(mktemp)
grep -E '^PREVIEW_GITHUB_CLIENT_(ID|SECRET)=' .dev.vars | sed 's/^PREVIEW_//' > "$secrets_file"
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> "$secrets_file"
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler preview base-config secret bulk "$secrets_file"
rm "$secrets_file"
```

Without OAuth on Previews, skip this part.

For bearer mode, store the token in the base config so that MCP works on Previews. Use the same
`grep` file as for production, with `wrangler preview base-config secret bulk`.

#### GitHub secret, variable, and environments

The account ID isn't a secret, so set it yourself:

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID --body <account-id>
```

The `production` and `preview` environments are optional. Create them:

```sh
gh api --method PUT repos/<owner>/<name>/environments/production
gh api --method PUT repos/<owner>/<name>/environments/preview
```

If creating them fails because the account's plan doesn't include environments for private
repositories, skip them and continue. The workflows still run with the repository secrets.

Then set the health check variable:

```sh
gh variable set HEALTHCHECK_URL --body "https://<host>"
```

For a private web app on `workers.dev`, leave out `HEALTHCHECK_URL`. Access answers `/healthz`
there instead of the Worker, so the deploy workflow's health check can't reach it.

### 14. Deploy and check

Commit and push anything that step 13 changed:

```sh
git add -A
git diff --cached --quiet || git commit -m "Set the deployment configuration"
git push origin main
```

Then deploy in one of two ways.

**With `CLOUDFLARE_API_TOKEN` in `gh secret list`**, turn on deploys from GitHub Actions and
start one:

```sh
gh variable set DEPLOY_ENABLED --body true
gh workflow run deploy.yml --ref main
gh run list --workflow deploy.yml --event workflow_dispatch --limit 1 --json databaseId,headSha,status
gh run watch <run-id> --exit-status
```

The run's `headSha` must equal the output of `git rev-parse HEAD`. If the list doesn't show the
new run yet, wait a few seconds and list again.

If the deploy job fails with a missing secret, the log names it. Upload a missing Worker secret
yourself, as in step 13. For a missing GitHub secret, go back to its task in step 3. Then rerun
with `gh run rerun <run-id> --failed`.

**Without the token**, deploy from your machine with the Wrangler login, and leave
`DEPLOY_ENABLED` unset:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`, which is a built-in pnpm command. The Worker is live
either way. Put the API token task first in the report, with the two commands that turn on
deploys from GitHub Actions after it: `gh secret set CLOUDFLARE_API_TOKEN` and
`gh variable set DEPLOY_ENABLED --body true`.

After the deploy, check the live Worker:

```sh
curl -fsS https://<host>/healthz
```

It returns `{"ok":true}`. If `curl` can't resolve a custom domain that this run created, your
machine cached the answer from before the domain existed. Ask a public resolver for the address
and pin it, here and in the next checks:

```sh
curl -fsS --resolve "<host>:443:$(dig +short @1.1.1.1 <host> | head -1)" https://<host>/healthz
```

For a private web app on `workers.dev`, Access answers instead, so skip
this check. With GitHub OAuth, also check sign-in discovery:

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

### 15. Connect Claude

This task needs the deployed Worker, so it can't be part of step 3. Send it as its own message,
as in step 3.

With GitHub OAuth, ask the user to add `https://<host>/mcp` as a custom connector in claude.ai
(**Settings** > **Connectors** > **Add custom connector**), sign in, and ask Claude to call
`example_echo_message`. For Claude Code, the command is:

```sh
claude mcp add --transport http <name> https://<host>/mcp
```

In bearer mode, use a client that sends a fixed header, such as Claude Code:

```sh
claude mcp add --transport http <name> https://<host>/mcp \
  --header "Authorization: Bearer $(grep '^MCP_BEARER_TOKEN=' .dev.vars | cut -d= -f2-)"
```

Ask the user to run it in their own terminal from the project folder, so the token never appears
in your conversation. The shell reads the token from `.dev.vars`, so it also stays out of the
typed command and the shell history.

The tool returns the message it was sent. If sign-in ends with `access_denied`, the GitHub
account isn't in `ALLOWED_GITHUB_LOGINS`. A web-app-only project skips this step.

### 16. Finish

Apply the license answer from the inputs. To replace the license, replace `LICENSE` and the
license section of `README.md` before you commit.

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

Start the report with what the user still has to do, as a numbered list with one action in each
item and the exact command or page for it. If nothing is left, say so in the first line. Keep
the list apart from the status items.

Then report each item as done, skipped with the reason, or failed with the error:

- Repository: `https://github.com/<owner>/<name>`, private, created from the template, and its
  description if the user gave one.
- Halves kept and the prune commands run.
- MCP sign-in mode, the allowed GitHub accounts, and whether Previews support OAuth.
- Web access: public, or private with the Access app names, or Worker-level Access on
  `workers.dev`, and who may sign in.
- Hostname and the MCP URL, `https://<host>/mcp`.
- KV namespace IDs for production and Previews.
- Worker secrets set for production, and for Previews if any.
- Project secrets that `.dev.vars` holds, by name only.
- GitHub secrets, variables, and environments created.
- Result of `pnpm verify` after the last change.
- How the Worker was deployed: the deploy run's URL and its result, or a deploy from your machine.
- Results of the `/healthz`, `POST /mcp`, and `.well-known` checks.
- Whether the user connected Claude and `example_echo_message` worked.
- Whether Renovate is installed.
- Whether the project kept the MIT-0 license or replaced it.
- Whether `--finish` ran and the final commit is pushed.
- Template problems that you fixed or worked around, so that the user can fix the template.
- Anything that failed.
