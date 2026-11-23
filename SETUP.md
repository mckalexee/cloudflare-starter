# Set up a project from this template

This runbook is for a coding agent that starts in an empty folder with only a link to this
template and the person's idea. You interview the person about what they want to build, create
the project's repository, and run `node scripts/setup.ts` in a loop. The script hands you the
tasks that need the person, does the rest itself, and checks the result. Setup is finished when
the last block that `node scripts/setup.ts finish` prints starts with `DONE`. Then you build the
first things that the person asked for.

## Rules

- **What the request approves.** A request to set up a project from this template approves
  everything this runbook does: creating the private GitHub repository, every resource that the
  script's summary lists in GitHub and Cloudflare, pushes to `main`, and the deploys that the
  deploy workflow runs. Ask before you do anything else in either account.
- **Set up, then build.** Don't change the project's code or edit the setup files until `finish`
  prints `DONE`. Then build what the brief names, as
  [Build what the person asked for](#build-what-the-person-asked-for) describes. If the person
  asks for more along the way, add it to the brief.
- **Read every run's whole output.** Don't cut it with `tail`, `head`, or a filter. The steps,
  the summary, and the final block all matter, and a cut output loses some of them.
- **Each open point has one owner.** Sort every open point into one of three kinds:
  - A **fact** is what the script, a command, the template's code and docs, or the accounts can
    tell you. Research it yourself, and never ask the person for it. The script already reads the
    accounts, the zones, the `workers.dev` subdomain, and the logins.
  - A **product** point is what a user sees or can do, who gets in, and what needs a new paid
    service or work from the person. The person decides it. Ask, and never guess.
  - **Engineering** is everything else, such as where data is kept. You decide it, even when no
    option is clearly best, and you never ask the person to choose.
- **The person's answers come from the person.** Never ask a question that the person already
  answered in their own words. Record the answer with `node scripts/setup.ts answer` and go on.
  What you infer from their other answers isn't an answer. It's a recommendation, so offer it
  and let them choose. This matters most for how people sign in.
- **One question at a time.** Ask through your structured question tool when you have one, such
  as `AskUserQuestion` in Claude Code. Put everything that the person needs into the question
  itself, offer options, and lead with the one that you recommend. Without such a tool, ask the
  one question in a message and wait for the answer. Never ask two questions at once.
- **The script says who answers.** Each `QUESTION` block that the script prints says whether the
  person or you answer it. Never answer for the person, and never ask the person a question
  that's yours.
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

## Interview

The interview has two parts: what the person is building, and what setup needs from them. Start
from what the person already said, and ask only what's missing, one question at a time. Ask in
the person's terms, never in the template's, such as "parts" or "sign-in mode".

### What they're building

Find out what the project does for the people who use it. Keep asking until you can name the
first tools or pages that you'd build, and until you're 95% sure that the person would read your
description of what those do and say "yes, that's it". A one-line idea always gets follow-up
questions. Don't skip or rush this part: each product choice that you don't settle here is one
that you'd otherwise make for the person while you build.

For the first things to build, cover this ground:

- What each kind of user can do, and where they see it.
- Who can open or see what: each page, each record, and each link.
- What happens afterward: what can be changed, undone, or removed, and by whom.
- What the project sends to people, such as email: when, from whom, and where a reply goes.
- What happens in the cases that the idea didn't mention: nothing is there yet, the input is
  wrong, someone tries twice, or someone drops out.
- How it looks, when it has pages.
- What stays out.

Ask a product question when you can picture the person choosing either way and caring which.
When any reasonable person would accept your choice and it's cheap to change later, such as a
length limit, make the choice and note it as a default. The [playback](#playback) shows the
person your defaults before anything is built. Never ask a question whose every answer leads to
the same product, and never ask about a fact or an engineering choice.

To test whether you're done, draft the playback. Each line about what a user sees or can do
must come from the person or from your defaults. A line that comes from neither is a question
that you haven't asked yet. If the person says that they haven't decided something, record it as
an open point. An open point is never a question that you didn't ask.

### What setup needs from the person

Ask each of these unless the person already said it in their own words. Many of them come up
while you ask what the person is building.

1. **What's it called?** The name that people see. Suggest one from the idea, and suggest the
   project name that follows from it, such as `acme-tools` for Acme Tools, in the same question.
   [Bootstrap](#bootstrap) step 2 has the rules for a project name.
2. **Who uses it?** Only you, named people or a team, or anyone.
3. **How do they use it?** From an AI assistant such as Claude, in a browser, or both.
4. **If from an assistant, how do people sign in?** Never choose for the person, and never
   assume GitHub, even when the other answers point one way. Offer these three ways, and
   recommend the first unless one of the notes applies:
   - **With their email address, through Cloudflare Access.** It admits only the people or the
     email domains that the person names. It needs no app registration and no secrets.
   - **With their GitHub account.** Recommend it only when the tools must act on each user's
     GitHub account, or when anyone at all may use the project, because Access can't admit
     everyone. It needs a GitHub OAuth app, which the person registers during setup.
   - **With one shared token.** Recommend it only for a single client of the person's own, such
     as one script.
5. **If in a browser, who can open each page?** The answer depends on what's being built, so
   ask it about the pages from the first part: which ones anyone can open, and which ones need a
   sign-in. A project can have a sign-up page for anyone next to pages for named people only.
6. **Where does it run?** On a domain that's on Cloudflare, or on the free `workers.dev` address.

### What you decide

These follow from the interview. Decide them yourself, and never ask the person to choose:

- **Where data is kept.** Use KV storage for per-user settings and simple lookups. Setup creates
  it when the project has an MCP endpoint. Use a D1 database when the project keeps records that
  it filters, relates, or totals, such as requests that it lists by status.
- **Which parts the project keeps,** from how people use it.
- **The wording** of the brief and the description.
- **The license.** It's `none` unless the person said that the code is open source. If they said
  so and named no license, that choice is theirs, so ask whether they want `mit-0` or `mit`.

Name in the brief only what setup creates or what the person asked for.

Turn the interview into the script's answers with this table:

| From the interview                                     | Script answers                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| An assistant only, a browser only, or both             | `parts`: `mcp`, `web`, or `mcp,web`                                                             |
| The person chose sign-in through Cloudflare Access     | `sign-in`: `access`, and `who-may-sign-in`: their email addresses, an email domain, or both     |
| The person chose sign-in with GitHub                   | `sign-in`: `github`, and `allowed-github`: the users' GitHub logins, or `*` for anyone          |
| The person chose one shared token                      | `sign-in`: `bearer`                                                                             |
| The person said that anyone may open every page        | `web-access`: `public`                                                                          |
| The person said that at least one page needs a sign-in | `web-access`: `private`, and `who-may-sign-in`: their email addresses, an email domain, or both |
| What the project keeps, which you decide               | `database`: `d1` for a D1 database, or `none`                                                   |
| A domain on Cloudflare                                 | `hostname`: a hostname on that zone, such as `tools.example.com`                                |
| The free address                                       | `hostname`: `workers.dev`                                                                       |
| What the person called it                              | `display-name`: up to 60 characters                                                             |
| What they're building, in your words                   | `brief`, and `description`: one sentence that starts with a verb                                |
| The person didn't say that the code is open source     | `license`: `none`                                                                               |
| The person said that the code is open source           | `license`: the license that they named, or ask whether `mit-0` or `mit`                         |

The script enforces these rules, so recommend a combination that keeps them:

- A private web app next to `github` or `bearer` sign-in needs a custom domain. Without a domain,
  recommend `access` sign-in for named users, or a public web app.
- `access` sign-in and a private web app need a Zero Trust organization, which is free. Access
  admits only the email addresses and domains that you name, never anyone. An email domain
  admits everyone with an address there. When the person names specific people, ask whether the
  whole domain may sign in or only those people.
- With `access` sign-in, MCP sign-in doesn't work on pull request Previews.
- A custom hostname must be on a zone in the person's Cloudflare account.
- A private web app puts every page behind Cloudflare Access in production. A page that anyone
  may open on such a site needs two things in the first build: its pattern in `PUBLIC_PATHS`,
  and its path in the Access bypass application, as `docs/web.md` describes under "The public
  list". Note those pages in `.plans/first-build.md`.

### Playback

Write the **brief**: two to four sentences, in your words, that say what the project does for
its users and name the first tools or pages to build. It's 40 to 800 characters, and it names only
technology that setup creates or that the person asked for.

Before you create anything, tell the person in a few plain sentences what the project will do
and what you'll set up, and read them the brief. The playback has:

- The decisions that the person made, as they made them: what it's called, how people sign in,
  and who can open which pages.
- The defaults that you chose, one line each, so that the person can change any of them.
- What you decided yourself that creates something, such as where data is kept, named as your
  own choice.
- What stays out.

Each line about what a user sees or can do comes from the person or from your defaults. Then ask
one question: is this right? On a no, go back to the part of the interview that their answer
changes.

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

2. Settle the **project name**: lowercase letters, digits, and hyphens, starting with a letter,
   at most 40 characters, such as `acme-tools`. If the person agreed to one in the interview, use
   it. Otherwise ask for it, and suggest one from the name that they gave the project. It names the
   repository, the Worker, the KV namespaces, and the D1 databases. Previews prepend
   `pr-<number>-` to it, which is why it stays short.

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

5. From the project folder, record what the interview settled, in this order, and skip each key
   that doesn't apply to the choices: `brief`, `display-name`, `description`, `parts`, `sign-in`,
   `web-access`, `who-may-sign-in`, `database`, `allowed-github`, `hostname`, and `license`. For
   example:

   ```sh
   node scripts/setup.ts answer brief "Tracks support requests for the Acme team. First, build a tool that lists open requests."
   ```

6. Write what the interview settled to `.plans/first-build.md` in the project folder: the goal,
   each decision that the person made, in their words where you can, each default that you
   chose, and each open point. The
   brief is short, and this file holds the rest, so that the build after setup doesn't depend on
   what this session remembers. Git ignores `.plans/`, so the file isn't a change to the project.

7. Start the loop. The script reads the project name and the owner from the `origin` remote of
   the clone, so it never asks for them again.

## The loop

Run this from the project folder, again and again:

```sh
node scripts/setup.ts
```

Each run first runs the work steps that are due, one after another. Each step prints a `STEP:`
heading, its commands, and its result. The run then ends with one block, whose first line names
what comes next and whose last line starts with `Next:`.

| Block                      | What you do                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QUESTION: <key>`          | The block says who answers. If it's you, decide from the interview. If it's the person and they already said it, use that. Otherwise ask them. Record the answer with `node scripts/setup.ts answer <key> <value>`, quoting a value that has spaces, and run the script again. |
| `TASK: <id>`               | Relay the instruction and the link. Wait until the person says it's done, and run the script again. For `mcp-client`, record the person's `done`, `not-now`, or `failed` with `answer`. For `renovate`, record their `done` or `not-now`. Never answer a task for them.        |
| `WAIT: <id>`               | Run the script again in about a minute. It's waiting on a GitHub Actions run, whose URL it prints. If the same run is still waiting after 30 minutes, report its URL to the person.                                                                                            |
| `DONE`                     | Relay the report, then run `node scripts/setup.ts finish`.                                                                                                                                                                                                                     |
| `REFUSED: <command>`       | Read the reason, fix it, and run the command again.                                                                                                                                                                                                                            |
| `FAILED: <command>`        | A check of GitHub or Cloudflare failed, so the script stopped instead of guessing. Fix the cause it names, such as a missing login, and run it again.                                                                                                                          |
| `Result: the step failed.` | The run exits with code 1. Read the step's output. Fix what you can and run the script again. If only the person can fix it, relay the result and wait.                                                                                                                        |

A run that ends with the `summary` step stops there. Relay the summary of what setup creates in
GitHub and Cloudflare to the person, then run the script again. Nothing has changed in either
account before that.

The run goes in this order: the questions that need no account, the local steps through the
install, the person's block, the summary, and then the script's own work. The person's block holds
the logins, the questions that read the accounts, and the tasks, back to back while the person is
at the keyboard. Each task says how many tasks are left in the block. A task that's already done
never appears, so when the person is signed in already, no login task shows up. Only
`mcp-client` and `renovate` come after the deploy, at the very end. Every other task, the API
token included, is in the person's block. These are all the person tasks:

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

If the Cloudflare account already has a KV namespace, a D1 database, or a Worker with the
project's name, which setup didn't create, the script asks whether it's from an earlier attempt
at this setup. Ask the person. Setup uses it only on a yes.

These answers can change at any time, and the next run applies them: `description`, which
changes the repository description and the MCP server's first sentence, `who-may-sign-in`, which
updates the Access policy, `allowed-github`, and `display-name`, which changes `APP_NAME` but not
the docs that the rename step already wrote. The parts, the sign-in mode, the database, and the
hostname can't change once a step used them, and neither can the project name or the owner,
which come from the `origin` remote. The script says so when you try.

## Two ways to stop

Asking a question or relaying a task and waiting for the reply is part of the work, not a stop.
Stopping means ending your work, and it happens in exactly one of these two ways:

1. The first things from the brief are in a pull request whose Preview checks pass, as
   [Build what the person asked for](#build-what-the-person-asked-for) describes.
2. You have nothing left to do and the run waits on one named person task. Then say
   `Setup is not finished. Waiting on: <task>`, followed by the task's instruction, the project
   folder, and the prompt that resumes the run in a new session. The script prints all three.

Don't stop anywhere else: not half set up, and not right after `finish`. Setup is finished when
the last block that `finish` prints starts with `DONE`. A plain run's `DONE` means that `finish`
comes next.

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

## Build what the person asked for

Setup being finished isn't the end of the request. `finish` moves the brief into the
**What to build** section of `AGENTS.md`, and its `DONE` block prints it.

From here, work the way that the **How to work** section of `AGENTS.md` describes. It and
`docs/workflow.md` stay in the project after this runbook is gone, so read them now. Don't write
code before the plan exists, is reviewed, and has the person's yes. For the first build:

1. **Investigate** from the brief and `.plans/first-build.md`, not from what you remember of the
   interview. The interview covered the goal, so ask the person only the product questions that
   are still open. Research
   the facts in the project's code now that it exists.
2. **Plan** in `.plans/first-build.md`, under the notes from the interview. The plan covers what
   happens to the examples, which go and don't stay next to the new work:
   - With an MCP endpoint, follow "Replace the example tools" in `AGENTS.md`: the new tools
     replace `example_echo_message`, `account_record_visit`, and the example `profile` scope
     where the new tools don't need it. Then follow "Add an MCP tool" for each tool.
   - With a web app, the first page replaces the example home page in `src/web/routes/home.tsx`.
     Follow "Add a route" for each other page. The plan says for each page who can open it, as
     the person decided. If they didn't say, ask.
3. **Review the plan, play it back, implement, and deliver**, as `docs/workflow.md` describes
   each phase. Work on a branch, such as `feat/first-tools`, and open the pull request with
   `gh pr create`. Merging deploys to production, so leave the merge to the person.

Keep the **What to build** section true as the plan changes, or delete it when it stops
helping.

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
- **`Port <port> is already in use`** when you run `pnpm dev`. Setup gives each project its own
  port, derived from the project name, so the process that holds it is often another copy of the
  same project, such as one in another working tree. Run the second copy on a free port with
  `pnpm dev --port <n>`. A sign-in flow that depends on a registered callback URL works only on
  the project's own port. To change the port of a project that's already set up, change
  `server.port` in `vite.config.ts`, the `localhost` URLs in the docs, and, when the project signs
  in with GitHub, the callback URL of the GitHub OAuth app. Setup itself never starts the dev
  server.
- **A run takes a while.** The probes call GitHub and Cloudflare, and the install and
  `pnpm verify` take a minute or two. Wait for the run to end.
- **Rehearse in a scratch copy.** `SETUP_FIXTURE=<file>` replaces every probe of GitHub and
  Cloudflare with the facts in the file and skips the remote steps. It writes fake IDs into the
  project, locks answers, and lets `finish` remove the setup files with no remote checks, so use
  it only in a throwaway copy, never in a real project. The script refuses fixture mode unless the
  `origin` owner is `example`, such as `https://github.com/example/acme-tools.git`. Fixture mode
  doesn't copy the script outside the repository, push, or wait for a deploy. The template's CI
  uses `scripts/setup/fixture.json`.
