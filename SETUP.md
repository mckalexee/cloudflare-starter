# Set up a project from this template

This runbook is for a coding agent that starts in an empty folder with only a link to this
template. You create the project's repository, then run `node scripts/setup.ts` in a loop. The
script asks the questions, hands you the tasks that need the person, does the rest itself, and
checks the result. Setup is finished when the last block that `node scripts/setup.ts finish`
prints starts with `DONE`.

## Rules

- **What the request approves.** A request to set up a project from this template approves
  everything this runbook does: creating the private GitHub repository, every resource that the
  script's summary lists in GitHub and Cloudflare, pushes to `main`, and the deploys that the
  deploy workflow runs. Ask before you do anything else in either account.
- **Set up first, build second.** Don't change the project's code, add features, or edit the
  setup files until setup is finished. If the person asks for a feature, note it and come back
  to it after `finish`.
- **One question at a time.** Ask each question that the script prints through your structured
  question tool when you have one, such as `AskUserQuestion` in Claude Code. Offer the script's
  options and mark its suggested answer. Without such a tool, ask the one question in a message
  and wait for the answer. Never ask two questions at once. When a question has no suggested
  answer and the person's request doesn't answer it, ask the person. Never invent an answer.
- **Look it up before you ask.** Never ask the person for something that the script, a command,
  or the accounts can tell you. The script already reads the accounts, the zones, the
  `workers.dev` subdomain, and the logins.
- **Person tasks one at a time.** Relay each task's instruction and link as the script prints
  them, wait until the person says it's done, then run the script again. The script checks the
  result itself.
- **Secrets stay out of the conversation.** Never print a secret, and never ask the person to
  paste one into the conversation. The person writes secrets into files that the script names,
  and the script reads them from there.
- **Don't work around the script.** Don't edit `setup.json`, `setup.local.json`, the
  `@starter:` marker comments, or the block at the top of `AGENTS.md`. Change an answer with
  `node scripts/setup.ts answer`. When the script stops with a failure, fix the cause it names,
  or relay it to the person when only they can fix it.

## Bootstrap

1. Check the tools. Each command must succeed:

   ```sh
   node --version   # v24 or later
   pnpm --version   # 12 or later; package.json pins the exact version
   git --version
   gh auth status   # signed in to GitHub
   ```

   If a tool is missing, ask the person to install it. Don't run `pnpm install` yourself: the
   script installs the dependencies in its install step. If `gh auth status` reports no login, ask
   the person to run `gh auth login` in their terminal. Then check again.

2. Ask for the **project name**: lowercase letters, digits, and hyphens, starting with a letter,
   at most 40 characters, such as `acme-tools`. It names the repository, the Worker, and the KV
   namespaces. Previews prepend `pr-<number>-` to it, which is why it stays short.

3. Ask for the **GitHub owner**: the person's account or one of their organizations. Suggest the
   login that `gh api user --jq .login` prints, and list the organizations from
   `gh api user/orgs --jq '.[].login'` as the other options. If that list is empty or the call
   fails, offer the login alone. Ask this after the person has answered the project name.

4. Create the repository from the template and clone it. `<template>` is the `owner/name` of the
   repository that you read this file from, such as `mckalexee/cloudflare-starter`, so a fork of
   the template works the same way. If the new repository already exists from an earlier attempt,
   which `gh repo view <owner>/<name>` shows, clone it instead and continue from step 5:

   ```sh
   gh repo create <owner>/<name> --template <template> --private --clone
   cd <name>
   git log --oneline -1
   ```

   If `git log` reports that the branch has no commits, GitHub hasn't finished copying the
   template. Wait five seconds, run `git pull origin main`, and check again, up to three times.
   If the branch is still empty, stop and report the output to the person.

5. From the project folder, start the loop. The script reads the project name and the owner from
   the `origin` remote of the clone, so it never asks for them again.

## The loop

Run this from the project folder, again and again:

```sh
node scripts/setup.ts
```

Each run first runs the work steps that are due, one after another. Each step prints a `STEP:`
heading, its commands, and its result. The run then ends with one block, whose first line names
what comes next and whose last line starts with `Next:`.

| Block                      | What you do                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUESTION: <key>`          | Ask the question. Record the answer with `node scripts/setup.ts answer <key> <value>`, quoting a value that has spaces, and run the script again.                                                                      |
| `TASK: <id>`               | Relay the instruction and the link. Wait until the person says it's done, and run the script again. For `mcp-client`, record `done`, `not-now`, or `failed` with `answer`. For `renovate`, record `done` or `not-now`. |
| `WAIT: <id>`               | Run the script again in about a minute. It's waiting on a GitHub Actions run, whose URL it prints. If the same run is still waiting after 30 minutes, report its URL to the person.                                    |
| `DONE`                     | Relay the report, then run `node scripts/setup.ts finish`.                                                                                                                                                             |
| `REFUSED: <command>`       | Read the reason, fix it, and run the command again.                                                                                                                                                                    |
| `FAILED: <command>`        | A check of GitHub or Cloudflare failed, so the script stopped instead of guessing. Fix the cause it names, such as a missing login, and run it again.                                                                  |
| `Result: the step failed.` | The run exits with code 1. Read the step's output. Fix what you can and run the script again. If only the person can fix it, relay the result and wait.                                                                |

A run that ends with the `summary` step stops there. Relay the summary of what setup creates in
GitHub and Cloudflare to the person, then run the script again. Nothing has changed in either
account before that.

The run goes in this order: the questions that need no account, the local steps through the
install, the person's block, the summary, and then the script's own work. The person's block holds
the logins, the questions that read the accounts, and the tasks, back to back while the person is
at the keyboard. Each task says how many tasks are left in the block. Two tasks come at the very
end, after the deploy. These are all the person tasks:

| Task                        | When it applies                                                                  |
| --------------------------- | -------------------------------------------------------------------------------- |
| `login-github`              | Always. It's done already when `gh auth status` passed in the bootstrap.         |
| `login-wrangler`            | Always.                                                                          |
| `login-cf`                  | The web app is private, or MCP clients sign in through Cloudflare Access.        |
| `zero-trust-org`            | The same choices, when the Cloudflare account has no Zero Trust organization.    |
| `github-oauth-app`          | MCP clients sign in with GitHub.                                                 |
| `github-oauth-app-previews` | MCP clients sign in with GitHub, and Previews support MCP sign-in.               |
| `cloudflare-api-token`      | Always.                                                                          |
| `new-name`                  | The person said that resources with the project's name belong to something else. |
| `mcp-client`                | The project keeps the MCP endpoint. Last, and `not-now` is an accepted answer.   |
| `renovate`                  | Always. Last, and `not-now` is an accepted answer.                               |

When the person says that MCP sign-in failed, record `answer mcp-client failed`. The next run names
the next check.

If the Cloudflare account already has a KV namespace or a Worker with the project's name, which
setup didn't create, the script asks whether it's from an earlier attempt at this setup. Ask the
person. Setup uses it only on a yes.

These answers can change at any time, and the next run applies them: `description`, which
changes the repository description and the MCP server's first sentence, `who-may-sign-in`, which
updates the Access policy, `allowed-github`, and `display-name`, which changes `APP_NAME` but not
the docs that the rename step already wrote. The parts, the sign-in mode, and the hostname can't
change once a step used them, and neither can the project name or the owner, which come from the
`origin` remote. The script says so when you try.

## Two ways to stop

Asking a question or relaying a task and waiting for the reply is part of the loop, not a stop.
Stopping means ending your work while setup is unfinished or finished, and it happens in exactly
one of these two ways:

1. The last block that `node scripts/setup.ts finish` prints starts with `DONE`, and it exits
   with code 0. A plain run's `DONE` isn't the end: it means that `finish` comes next.
2. You have nothing left to do and the run waits on one named person task. Then say
   `Setup is not finished. Waiting on: <task>`, followed by the task's instruction, the project
   folder, and the prompt that resumes the run in a new session. The script prints all three.

Don't stop anywhere else, and don't call setup finished while a check is open.

## Finish

```sh
node scripts/setup.ts finish
```

`finish` refuses while any check is open. Otherwise it copies the setup script and its state to
`~/.config/setup-<owner>-<name>/finish`, outside the repository, removes the setup files, runs
`pnpm verify`, commits `Remove the template setup files`, and pushes it to `main`. If GitHub
refuses the push, such as because of a branch protection rule, `finish` puts the setup files back
and stops. The person then allows pushes to `main` for setup, and you run `finish` again. Then it waits for
the deploy job of that commit and the live checks. A wait prints `WAIT: finish` with a resume
command that runs from the copy, because the setup files are gone by then. Run that command until
its last block starts with `DONE`. Before it removes anything, `finish` prints the same resume
command. If a run stops partway, such as when the session ends, run it: it puts the setup files
back when the commit didn't happen, and continues when it did.

If a local step fails, `finish` puts the setup files back. If the deploy or a live check fails
after the push, it reverts the finish commit with a new commit, never rewriting `main`, and puts
the state back. Fix the cause, run `node scripts/setup.ts` until it prints `DONE`, and run
`finish` again.

## Report to the person

Lead with what's still open: each task that the person answered with `not-now`, with the
instruction that the `DONE` report gives for it. Then relay the rest of the `DONE` report: the
repository, the parts and sign-in mode, the hostname and the MCP URL, the deploy run, and the live
checks.

## Troubleshooting

- **`REFUSED` because the origin remote is the template.** You're in a clone of the template, not
  of the new project. Go back to [Bootstrap](#bootstrap).
- **`REFUSED` because `CLOUDFLARE_API_TOKEN` is set.** The Cloudflare CLI and Wrangler would use
  that token instead of the logins. Unset it in the shell, or remove it from the project's `.env`
  file.
- **The Cloudflare CLI login expired.** `pnpm exec cf auth login` shows a code that expires after 5
  minutes. Run the script again, and relay the task again.
- **GitHub rejected the OAuth client ID and secret.** The task says so. The person generates a
  new client secret and writes both values into `.dev.vars` again.
- **A live check failed right after the first deploy.** A new custom domain can take a few minutes
  to answer. Run the script again after a few minutes. After `finish` pushes, a failed live check
  waits and retries up to five times before `finish` reverts its commit.
- **The deploy job failed twice.** The script shows the job's log. This is the one case where you
  change files before setup is finished: fix the cause that the log names, and run the script
  again. Its verify and commit steps check and commit the fix, and its push step pushes it.
- **`Port 5173 is already in use`** when you run `pnpm dev`. Ask the person to stop the process
  that holds the port. Setup itself never starts the dev server.
- **A run takes a while.** The probes call GitHub and Cloudflare, and the install and
  `pnpm verify` take a minute or two. Wait for the run to end.
- **Rehearse in a scratch copy.** `SETUP_FIXTURE=<file>` replaces every probe of GitHub and
  Cloudflare with the facts in the file and skips the remote steps. It writes fake IDs into the
  project, locks answers, and lets `finish` remove the setup files with no remote checks, so use
  it only in a throwaway copy, never in a real project. The script refuses fixture mode unless the
  `origin` owner is `example`, such as `https://github.com/example/acme-tools.git`. Fixture mode
  doesn't copy the script outside the repository, push, or wait for a deploy. The template's CI
  uses `scripts/setup/fixture.json`.
