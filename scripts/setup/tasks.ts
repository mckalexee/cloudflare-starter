// The tasks that only the person can do, with the text that the agent relays. Each task says when
// it applies, how the script sees that it's done, and one instruction with a link. Most tasks come
// in one block before the script's own work. Connecting an MCP client and installing Renovate
// come last, and the person's answer, which can be "not now", closes them.
import {
  accessUsed,
  accountId,
  accountLabel,
  apiTokenLink,
  customDomain,
  hasMcp,
  host,
  signIn,
  workersSubdomain,
  zoneFor,
} from "./derive.ts";
import type { Context, TaskId } from "./types.ts";

/** Everything the script knows about one person task. */
export type TaskSpec = {
  id: TaskId;
  /** `first` tasks come before the script's work, and `last` tasks after the deploy. */
  block: "first" | "last";
  title: string;
  applies: (ctx: Context) => boolean;
  done: (ctx: Context) => boolean;
  instruction: (ctx: Context) => string[];
  link: (ctx: Context) => string;
  detection: (ctx: Context) => string;
  /** For the last two tasks: the answer key that records the person's result. */
  answerKey?: "mcp-client" | "renovate";
};

const CF_SCOPES = "account:read user:read access:read access:write offline";

function hasKeys(ctx: Context, keys: string[]): boolean {
  return keys.every((key) => ctx.repo.devVars[key] === true);
}

function githubAppsUrl(ctx: Context): string {
  const { owner } = ctx.repo.origin;
  return ctx.facts.github !== null && ctx.facts.github.login.toLowerCase() !== owner.toLowerCase()
    ? `https://github.com/organizations/${owner}/settings/applications/new`
    : "https://github.com/settings/applications/new";
}

// The Claude Code server entry for bearer mode. Its `headersHelper` command reads the token from
// `.dev.vars` when Claude Code connects, so the token stays out of every command line.
function bearerServerJson(ctx: Context, url: string): string {
  const devVars = `${ctx.repo.root}/.dev.vars`;
  const helper = `echo "{\\"Authorization\\":\\"Bearer $(grep ^MCP_BEARER_TOKEN= ${devVars} | cut -d= -f2-)\\"}"`;
  return JSON.stringify({ type: "http", url, headersHelper: helper });
}

function mcpUrl(ctx: Context): string {
  return `https://${host(ctx) ?? "<host>"}/mcp`;
}

/** Every person task, in the order the planner presents them. */
export const TASKS: TaskSpec[] = [
  {
    id: "login-github",
    block: "first",
    title: "Sign in to the GitHub CLI.",
    applies: () => true,
    done: (ctx) => ctx.facts.github !== null,
    instruction: () => ["Run `gh auth login` in your terminal and follow its prompts."],
    link: () => "https://cli.github.com/manual/gh_auth_login",
    detection: () => "`gh auth status` reports a signed-in account.",
  },
  {
    id: "login-wrangler",
    block: "first",
    title: "Sign in to Wrangler.",
    applies: () => true,
    done: (ctx) => ctx.facts.wrangler !== null,
    instruction: () => [
      `In your terminal, in the project folder, run \`pnpm exec wrangler login\` and approve the request in your browser.`,
    ],
    link: () => "https://developers.cloudflare.com/workers/wrangler/commands/#login",
    detection: () => "`wrangler whoami` lists at least one account.",
  },
  {
    id: "login-cf",
    block: "first",
    title: "Sign in to the Cloudflare CLI.",
    applies: (ctx) => accessUsed(ctx.answers),
    done: (ctx) => {
      const id = accountId(ctx);
      return ctx.facts.cf !== null && (id === undefined || ctx.facts.cf.accountIds.includes(id));
    },
    instruction: (ctx) =>
      ctx.facts.cf === null
        ? [
            `In your terminal, in the project folder, run \`pnpm exec cf auth login --scopes ${CF_SCOPES}\` and approve the request for the account ${accountLabel(ctx)} within 5 minutes.`,
          ]
        : [
            `The Cloudflare CLI is signed in, but not to the account ${accountLabel(ctx)}, which Wrangler uses. In the project folder, run \`pnpm exec cf auth login --force --scopes ${CF_SCOPES}\` and approve the request for that account.`,
          ],
    link: () => "https://developers.cloudflare.com/cf/get-started/",
    detection: (ctx) =>
      `\`cf auth whoami\` lists the account ${accountLabel(ctx)}, the same one that Wrangler uses.`,
  },
  {
    id: "zero-trust-org",
    block: "first",
    title: "Create a Zero Trust organization.",
    applies: (ctx) => accessUsed(ctx.answers),
    done: (ctx) => ctx.facts.accessOrganization !== null,
    instruction: (ctx) => [
      `Open the Cloudflare One dashboard, pick the account ${accountLabel(ctx)}, choose a team name, and finish the onboarding with the Free plan.`,
    ],
    link: () => "https://one.dash.cloudflare.com/",
    detection: () =>
      "The script reads the account's Zero Trust organization instead of getting a not found answer.",
  },
  {
    id: "github-oauth-app",
    block: "first",
    title: "Create the GitHub OAuth app and put its client ID and secret in .dev.vars.",
    applies: (ctx) => signIn(ctx.answers) === "github",
    done: (ctx) =>
      hasKeys(ctx, ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) &&
      ctx.facts.githubOAuth.production === true,
    instruction: (ctx) => {
      const hostname = host(ctx) ?? "<host>";
      const lines =
        ctx.facts.githubOAuth.production === false
          ? [
              "GitHub rejected the client ID and secret in `.dev.vars`. Generate a new client secret and replace both values.",
            ]
          : [];
      if (lines.length === 0 && (ctx.facts.workerSecrets ?? []).includes("GITHUB_CLIENT_ID")) {
        // A fresh clone has no `.dev.vars`, but the Worker already uses an OAuth app.
        return [
          "The Worker already has a GitHub OAuth app from an earlier run, so don't register another one. Open the existing app, select Generate a new client secret, and write its client ID and the new secret into `.dev.vars` in the project folder as `GITHUB_CLIENT_ID=<client ID>` and `GITHUB_CLIENT_SECRET=<client secret>`. The script uploads the new secret. Don't paste them into the conversation.",
        ];
      }
      return [
        ...lines,
        `Register a GitHub OAuth app named "${ctx.answers["display-name"] ?? ctx.repo.origin.name}" with the homepage URL https://${hostname} and two callback URLs, https://${hostname}/callback and http://localhost:5173/callback, with wildcard matching off. Then select Generate a new client secret, and write both values into \`.dev.vars\` in the project folder as \`GITHUB_CLIENT_ID=<client ID>\` and \`GITHUB_CLIENT_SECRET=<client secret>\`, each on its own line. Don't paste them into the conversation.`,
      ];
    },
    link: githubAppsUrl,
    detection: () =>
      "`.dev.vars` holds both values, and GitHub accepts the pair when the script checks it.",
  },
  {
    id: "github-oauth-app-previews",
    block: "first",
    title: "Create the GitHub OAuth app for Previews and put its values in .dev.vars.",
    applies: (ctx) => signIn(ctx.answers) === "github" && ctx.answers["oauth-previews"] === "yes",
    done: (ctx) =>
      hasKeys(ctx, ["PREVIEW_GITHUB_CLIENT_ID", "PREVIEW_GITHUB_CLIENT_SECRET"]) &&
      ctx.facts.githubOAuth.preview === true,
    instruction: (ctx) => {
      const subdomain = workersSubdomain(ctx) ?? "<subdomain>";
      const lines =
        ctx.facts.githubOAuth.preview === false
          ? [
              "GitHub rejected the Preview client ID and secret in `.dev.vars`. Generate a new client secret and replace both values.",
            ]
          : [];
      if (lines.length === 0 && ctx.facts.previewSecrets.includes("GITHUB_CLIENT_ID")) {
        return [
          "The Preview base config already has a GitHub OAuth app from an earlier run, so don't register another one. Open the existing Previews app, generate a new client secret, and write its client ID and the new secret into `.dev.vars` as `PREVIEW_GITHUB_CLIENT_ID=<client ID>` and `PREVIEW_GITHUB_CLIENT_SECRET=<client secret>`.",
        ];
      }
      return [
        ...lines,
        `Register a second GitHub OAuth app, used only by Previews, named "${ctx.answers["display-name"] ?? ctx.repo.origin.name} Previews" with the callback URL https://${subdomain}.workers.dev/callback and wildcard matching on. Wildcard matching lets any Worker on that subdomain receive sign-in codes for this app, which is why it's separate from production. Generate a client secret, and write both values into \`.dev.vars\` as \`PREVIEW_GITHUB_CLIENT_ID=<client ID>\` and \`PREVIEW_GITHUB_CLIENT_SECRET=<client secret>\`.`,
      ];
    },
    link: githubAppsUrl,
    detection: () =>
      "`.dev.vars` holds both Preview values, and GitHub accepts the pair when the script checks it.",
  },
  {
    id: "cloudflare-api-token",
    block: "first",
    title: "Create the Cloudflare API token for GitHub Actions and save it in a file.",
    applies: () => true,
    done: (ctx) => ctx.facts.apiToken.saved && ctx.facts.apiToken.valid === true,
    instruction: (ctx) => {
      const hostname = host(ctx);
      const zone =
        customDomain(ctx.answers) && hostname !== undefined ? zoneFor(ctx, hostname) : undefined;
      const lines =
        ctx.facts.apiToken.saved && ctx.facts.apiToken.valid === false
          ? [
              "Cloudflare rejected the token in the file. Create a new token and replace the file's contents.",
            ]
          : ctx.facts.githubSecrets.includes("CLOUDFLARE_API_TOKEN")
            ? [
                "The repository already has a CLOUDFLARE_API_TOKEN secret from an earlier run, but its token file is gone. A new token replaces the old one in GitHub, and you can delete the old token in the dashboard afterward.",
              ]
            : [];
      return [
        ...lines,
        `Open the link, which fills in the permissions, and pick the account ${accountLabel(ctx)}. Scope the account permissions to that account` +
          (zone === undefined
            ? ""
            : ` and the Workers Routes permission to the zone ${zone.name}`) +
          `. Create the token, then save it as the only contents of the file ${ctx.repo.apiTokenFile}, which is outside the repository. Create the folder if it's missing. Don't paste the token into the conversation.`,
      ];
    },
    link: apiTokenLink,
    detection: (ctx) =>
      `The file ${ctx.repo.apiTokenFile} exists, and Cloudflare's token verification accepts the token in it.`,
  },
  {
    id: "new-name",
    block: "first",
    title: "Start again with another project name.",
    applies: (ctx) => ctx.answers["existing-resources"] === "something-else",
    done: () => false,
    instruction: (ctx) => [
      `Resources named after ${ctx.repo.origin.name} already exist in the account and belong to something else, so setup won't use this name. Create a new repository from the template with another name, as SETUP.md describes, and run setup there. This repository can be deleted.`,
    ],
    link: () => "https://github.com/mckalexee/cloudflare-starter/blob/main/SETUP.md",
    detection: () => "It doesn't. Setup continues in the new repository.",
  },
  {
    id: "mcp-client",
    block: "last",
    title: "Connect an MCP client and sign in.",
    applies: (ctx) => hasMcp(ctx.answers),
    done: (ctx) => {
      const answer = ctx.local.answers["mcp-client"];
      return answer === "done" || answer === "not-now";
    },
    instruction: (ctx) => {
      const url = mcpUrl(ctx);
      const name = ctx.repo.origin.name;
      const mode = signIn(ctx.answers);
      const failed = ctx.local.answers["mcp-client"] === "failed";
      const connect =
        mode === "bearer"
          ? `In your terminal, run \`claude mcp add-json ${name} '${bearerServerJson(ctx, url)}'\`. Claude Code then reads the token from \`.dev.vars\` each time it connects, so the token never appears in a command or its configuration. Then ask Claude to call \`example_echo_message\`.`
          : `Add ${url} as a custom connector in claude.ai under Settings > Connectors > Add custom connector, or run \`claude mcp add --transport http ${name} ${url}\` and then \`/mcp\` in Claude Code. Sign in, then ask Claude to call \`example_echo_message\`.`;
      if (!failed) {
        return [connect];
      }
      const check =
        mode === "github"
          ? `Sign-in failed. If it ended with access_denied, the GitHub account isn't in the allowed accounts: change them with \`node scripts/setup.ts answer allowed-github <logins>\`. Otherwise compare the callback URL in the GitHub OAuth app with https://${host(ctx) ?? "<host>"}/callback, and generate a new client secret into \`.dev.vars\` so the script uploads it again.`
          : mode === "access"
            ? "Sign-in failed. Check that the email address you signed in with is in the Access policy: change it with `node scripts/setup.ts answer who-may-sign-in <entries>`. If the login page offers no method that works for you, add the one-time PIN login method in the Zero Trust dashboard."
            : "The connection failed. Check that the client sends the token from `.dev.vars` in the Authorization header. To use a fresh token, replace MCP_BEARER_TOKEN in `.dev.vars`, and the script uploads it again.";
      return [check, `Then try again: ${connect}`];
    },
    link: (ctx) =>
      `https://github.com/${ctx.repo.origin.owner}/${ctx.repo.origin.name}#connect-an-mcp-client`,
    detection: () => "The person's answer. Not now is an accepted answer.",
    answerKey: "mcp-client",
  },
  {
    id: "renovate",
    block: "last",
    title: "Install Renovate.",
    applies: () => true,
    done: (ctx) => {
      const answer = ctx.local.answers.renovate;
      return answer === "done" || answer === "not-now";
    },
    instruction: (ctx) => [
      `Install the Renovate GitHub app and grant it access to ${ctx.repo.origin.owner}/${ctx.repo.origin.name}. Renovate reads renovate.json5 and opens its first update pull requests on its weekly schedule.`,
    ],
    link: () => "https://github.com/apps/renovate",
    detection: () => "The person's answer. Not now is an accepted answer.",
    answerKey: "renovate",
  },
];

/** Looks up a task by ID. */
export function task(id: TaskId): TaskSpec {
  const spec = TASKS.find((candidate) => candidate.id === id);
  if (spec === undefined) {
    throw new Error(`Unknown task ${id}.`);
  }
  return spec;
}
