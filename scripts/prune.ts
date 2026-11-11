// Turns the template into one project variant, and later removes the template's prune machinery.
// The setup names the whole selection in one run:
//
//   node scripts/prune.ts --parts <mcp,web|mcp|web> [--sign-in <github|bearer|access>] [--finish]
//
// `--parts` lists the parts to keep, separated by commas. `--sign-in` picks how MCP clients sign
// in: GitHub OAuth, one static bearer token, or Cloudflare Access. It's required when the MCP
// endpoint stays and not allowed without it. `--parts mcp,web --sign-in github` keeps the template
// as it is. The older single-variant form still works, one variant per run:
//
//   node scripts/prune.ts <mcp-only|app-only|bearer> [--finish]
//
// `mcp-only` keeps the MCP endpoint with GitHub OAuth, `app-only` keeps the web app, and `bearer`
// keeps both parts in bearer mode. An MCP-only project in bearer mode runs `mcp-only` and then
// `bearer`. `--finish` alone finishes a project that keeps both parts with GitHub OAuth.
//
// A selection deletes the marked blocks of the kinds it drops, replaces the blocks that it swaps
// for other content, deletes the files that belong only to those kinds, and removes their
// dependencies from `package.json`. A marker is a comment line that holds only `@starter:mcp`,
// `@starter:web`, `@starter:oauth`, or `@starter:access`, such as `// @starter:web` in code or
// `<!-- @starter:web -->` in Markdown, and a later `@starter:end` line closes the block. Blocks
// don't nest. `@starter:oauth` blocks belong to the OAuth flow inside the MCP part, so bearer mode
// and Access sign-in drop them, or swap them for their own code, and keep the rest of the MCP part.
// `@starter:access` blocks belong to the Cloudflare Access identity check, which both the web app
// and Access sign-in use, so only a selection with neither drops them.
//
// `--finish` strips the remaining marker lines and rewrites the `Halves present:` line in
// `AGENTS.md` to name what's left. It deletes `SETUP.md` and the `README.md` line that points to
// it, because setup ends with `--finish`. It also deletes the setup script and its state files,
// the block in `AGENTS.md` that says setup isn't finished, the `.gitignore` entry for the setup
// state, the header sentences that explain the markers, the CI job that tests setup, and this
// script itself. Markers can't remove text that `--finish` must delete, so these steps are text
// edits.
//
// The script plans every change in memory and writes nothing when any check fails, so a stale
// path or a missing anchor leaves the tree as it was. It runs before `pnpm install`, so it uses
// only Node built-ins. It edits text the way `oxfmt` would print it, because `pnpm verify` checks
// the formatting.
import { lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type Kind = "mcp" | "web" | "oauth" | "access";
type Variant = "mcp-only" | "app-only" | "bearer";
type Part = "mcp" | "web";
type SignIn = "github" | "bearer" | "access";

// The parts to keep and, with the MCP endpoint, how MCP clients sign in.
type Selection = { parts: ReadonlySet<Part>; signIn: SignIn | undefined };

// One piece of a selection's changes. A selection applies every fragment that it needs in one run.
type Fragment =
  | "no-web"
  | "no-mcp"
  | "bearer"
  | "access-sign-in"
  | "access-without-web"
  | "no-access";

// A path to delete. With `keep`, the path is a directory and everything in it except the listed
// paths is deleted.
type Removal = { path: string; keep?: string[] };

// Replaces a marked block, markers included, with `content`, instead of deleting or keeping it. A
// swap applies to the one block in `file` whose text contains `anchor`. An empty `content` deletes
// the block, for text that holds only while a kind that the selection keeps sits next to one that
// it drops.
type Swap = { file: string; anchor: string; content: string };

// An edit for `--finish` that markers can't express. `apply` throws an `Error` when the text it
// expects is missing, so a template change that breaks the edit fails loudly.
type TextEdit = { file: string; description: string; apply: (text: string) => string };

type FragmentSpec = {
  dropKinds: Kind[];
  paths: Removal[];
  dependencies: string[];
  // Removed only when no remaining source file imports the package.
  dependenciesIfUnused: string[];
  scripts: Record<string, { from: string; to: string }>;
  swaps: Swap[];
  // Every `mcp` or `oauth` block in these files must match a swap, so OAuth code can't survive in a
  // selection that replaces it.
  swapsCover: string[];
};

const ROOT = path.resolve(import.meta.dirname, "..");
const SELF = "scripts/prune.ts";
// The setup script and its state, which `--finish` deletes with this script.
const SETUP_FILES = ["scripts/setup.ts", "scripts/setup", "setup.json", "setup.local.json"];
const SETUP_BLOCK_START = "<!-- setup:begin -->";
const SETUP_BLOCK_END = "<!-- setup:end -->";
const SETUP_IGNORE = "setup.local.json";
const AGENTS = "AGENTS.md";
const SETUP = "SETUP.md";
const README = "README.md";
const HALVES_PREFIX = "Halves present:";
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  ".wrangler",
  ".react-router",
  "coverage",
]);
const SKIP_FILES = new Set([SELF, "pnpm-lock.yaml", "worker-configuration.d.ts"]);
const MARKER = /^\s*(?:\/\/|#|<!--)\s*@starter:([a-z]+)\s*(?:-->)?\s*$/;
const KINDS = new Set<string>(["mcp", "web", "oauth", "access"]);
const PARTS = new Set<string>(["mcp", "web"]);
const SIGN_INS = new Set<string>(["github", "bearer", "access"]);

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const COLLAPSIBLE_FILE = /\.(?:[cm]?[jt]sx?|json|jsonc|json5)$/;

// In bearer mode, `/mcp` goes to the bearer-token handler instead of the OAuth provider. These
// replace the `@starter:oauth` blocks in `src/worker.ts`.
const BEARER_WORKER_HEADER = `// In bearer mode, requests to \`/mcp\` go through the token check in \`src/auth/bearer.ts\`, and
// every other request goes to the Hono app.`;
const BEARER_WORKER_IMPORT = `import { bearerHandler } from "#auth/bearer.ts";`;
const BEARER_WORKER_ROUTE_IMPORT = `import { MCP_ROUTE } from "#mcp/handler.ts";`;
const BEARER_WORKER_HANDLER = `export default {
  fetch: (request, env, ctx) =>
    new URL(request.url).pathname === MCP_ROUTE
      ? bearerHandler.fetch(request, env, ctx)
      : appHandler.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;`;

// The Hono app is the whole Worker without the MCP endpoint, and with Access sign-in, which
// mounts its routes in the Hono app. This replaces the OAuth provider's export in `src/worker.ts`.
const APP_WORKER_HANDLER = `export default appHandler;`;

// Without the consent page, no popup needs `window.opener`, so `src/http/index.ts` keeps Hono's
// default `Cross-Origin-Opener-Policy`. Every selection that drops OAuth swaps in this assertion.
const DEFAULT_OPENER_POLICY_TEST = `    // No popup needs \`window.opener\`, so Hono's default applies.
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");`;

// Without the web app, the Vite build writes to `dist/` instead of React Router's `build/`.
const MCP_ONLY_BUILD_OUTPUT = `The Worker and its \`wrangler.json\` go to \`dist/ssr/\`, and the static assets to \`dist/client/\`.`;

// Without the web app, `src/http/access.ts` throws no `HttpError`, so it imports only the
// upstream error.
const MCP_ONLY_ACCESS_ERRORS_IMPORT = `import { UpstreamError } from "#lib/errors.ts";`;

// Bearer mode replaces the OAuth sentences in `AGENTS.md` and `README.md`.
const BEARER_AGENTS_INTRO = `\`src/auth/bearer.ts\` guards it with one static bearer token.`;
const BEARER_README_INTRO = `MCP clients authenticate with one static bearer token.`;
const BEARER_README_FEATURE = `**Bearer mode.** \`/mcp\` accepts one static token from the \`MCP_BEARER_TOKEN\` secret and
serves MCP as a single owner with every scope.`;
const BEARER_README_LOCAL = `For MCP requests, generate a bearer token into \`.dev.vars\` before you start the dev server.
MCP clients send it as \`Authorization: Bearer <token>\`.

\`\`\`sh
echo "MCP_BEARER_TOKEN=$(openssl rand -hex 32)" > .dev.vars
\`\`\``;
const BEARER_README_CLIENT = `Each client sends the token from \`MCP_BEARER_TOKEN\` in an \`Authorization: Bearer <token>\`
header, so use a client that can send a fixed header, such as Claude Code:

\`\`\`sh
claude mcp add --transport http <name> https://<host>/mcp --header "Authorization: Bearer <token>"
\`\`\``;

// The bearer token replaces the OAuth secrets in `wrangler.jsonc` and `.dev.vars.example`.
const BEARER_WRANGLER_SECRETS = `  // From \`.dev.vars\`, Wrangler loads these keys and any key named after a var, and ignores the
  // rest. It generates the secrets' types and refuses to deploy while one is missing.
  "secrets": {
    "required": ["MCP_BEARER_TOKEN"],
  },`;
const BEARER_DEV_VARS = `# Token that MCP clients send as \`Authorization: Bearer <token>\`. Generate one with
# \`openssl rand -hex 32\`.
MCP_BEARER_TOKEN=`;

const BEARER_AUTH_INTRO = `MCP clients authenticate with one static bearer token, as [Bearer mode](#bearer-mode) describes.`;

// Bearer mode has no consent page and no GitHub account. These replace the OAuth wording in the
// files that bearer mode keeps.
const BEARER_SCOPE_DESCRIPTIONS = `  profile: "See your login and name.",`;
const BEARER_ACCESS_TOKEN = `  // Bearer mode never sets \`accessToken\`.`;
const BEARER_MCP_TOKEN_CHECK = `In bearer mode, \`src/auth/bearer.ts\` checks the token against the \`MCP_BEARER_TOKEN\` secret.`;
const BEARER_HOST_CHECK = `\`createMcpApiHandler()\` in \`src/mcp/handler.ts\` checks the \`Host\` header only on \`localhost\` and
\`workers.dev\` by default. To apply the check on the custom domain, pass \`allowedHostnames\` where
\`src/auth/bearer.ts\` creates the production handler. Run \`pnpm test\` afterward, because the tests
send requests to \`localhost\`.`;
const BEARER_ACCESS_BYPASS = `\`\`\`json
{
  "type": "self_hosted",
  "name": "<name> MCP",
  "domain": "<host>/mcp",
  "destinations": [
    { "type": "public", "uri": "<host>/healthz" },
    { "type": "public", "uri": "<host>/mcp" }
  ],
  "policies": [
    {
      "name": "MCP clients",
      "decision": "bypass",
      "include": [{ "everyone": {} }]
    }
  ]
}
\`\`\`

The bypass application leaves those paths open to everyone. That's intended: \`/healthz\` reveals
nothing, and \`/mcp\` checks the bearer token.`;

// With Access sign-in, the Hono app serves `/mcp` through the routes in `src/auth/access.ts`.
// These replace the `@starter:oauth` blocks in `src/worker.ts` and `src/http/index.ts`.
const ACCESS_WORKER_HEADER = `// With Cloudflare Access sign-in, the Hono app also serves \`/mcp\`, through the routes from
// \`src/auth/access.ts\`.`;
const ACCESS_ROUTES_IMPORT = `import { accessRoutes } from "#auth/access.ts";`;
const ACCESS_ROUTES_MOUNT = `  app.route("/", accessRoutes);`;

// Access sign-in has no GitHub account, no upstream token, and no secrets. These replace the OAuth
// wording in the files that Access sign-in keeps.
const ACCESS_SCOPE_DESCRIPTIONS = `  profile: "See your email address and name.",`;
const ACCESS_ACCESS_TOKEN = `  // Cloudflare Access sign-in never sets \`accessToken\`.`;
const ACCESS_DEV_VARS = `# Cloudflare Access sign-in needs no secrets. Without a \`secrets\` block in \`wrangler.jsonc\`,
# Wrangler loads every key here, and a key with a var's name overrides that var locally.`;
const ACCESS_AGENTS_INTRO = `Cloudflare Access signs MCP clients in, and \`src/auth/access.ts\` checks the identity that Access
forwards.`;
const ACCESS_AGENTS_MCP_INVARIANTS = `- \`pnpm dev\` loads every \`.dev.vars\` key, because \`wrangler.jsonc\` has no \`secrets\` block, and a
  key named after a var overrides it. Tests bind fixed values over every var, so \`.dev.vars\`
  doesn't affect them.
- \`McpAgent\` is deprecated and banned by oxlint. Serve MCP through \`src/mcp/handler.ts\`.
- Per-user KV keys start with \`user:<id>:\`, so they stay apart from every other record in the
  namespace.`;
const ACCESS_AGENTS_INVARIANTS = `- Cloudflare Access is the authorization server for \`/mcp\`, through Managed OAuth.
  \`src/auth/access.ts\` serves MCP only to an identity that \`resolveIdentity()\` accepts, and
  answers 401 without one.
- \`/mcp\` refuses cross-origin browser requests and sends no CORS headers, because an Access
  session cookie can authenticate a browser. Keep both rules.`;
const ACCESS_README_INTRO = `MCP clients sign in through Cloudflare Access.`;
const ACCESS_README_FEATURE = `**Cloudflare Access sign-in.** Cloudflare Access is the authorization server for \`/mcp\`,
through Managed OAuth, and the Worker verifies the identity that Access forwards. It needs no
GitHub app and no Worker secrets.`;
const ACCESS_README_LOCAL = `For MCP requests under \`pnpm dev\`, the dev server fakes the Access identity from the \`access.dev\`
block in \`wrangler.jsonc\`. Set \`ACCESS_TEAM_DOMAIN\` and \`ACCESS_AUD\` under \`vars\`, and set
\`access.dev.aud\` to the same value as \`ACCESS_AUD\`. With the vars empty, \`/mcp\` answers \`401\`.`;
const ACCESS_README_ENDPOINTS = `- \`http://localhost:5173/.well-known/oauth-protected-resource/mcp\`: protected resource metadata,
  which names Cloudflare Access as the authorization server.
- \`http://localhost:5173/.well-known/oauth-protected-resource\`: the same document.`;
const ACCESS_README_CLIENT = `Against a deployed URL, each client opens a browser for the Cloudflare Access login, and the
Access application's policy decides who may connect.
[docs/auth.md](docs/auth.md#cloudflare-access-sign-in) describes the application. Against
\`pnpm dev\`, there's no login: requests to \`http://localhost:5173/mcp\` use the \`access.dev\`
identity from \`wrangler.jsonc\`.

- **claude.ai and Claude Desktop:** go to **Settings** > **Connectors** > **Add custom
  connector**, and enter the URL. claude.ai connects from Anthropic's servers, so it needs a
  deployed URL, not \`localhost\`.
- **Claude Code:** add the server, then run \`/mcp\` in Claude Code to sign in.

  \`\`\`sh
  claude mcp add --transport http <name> https://<host>/mcp
  \`\`\``;
const ACCESS_MCP_TOKEN_CHECK = `With Cloudflare Access sign-in, Access validates the client's token, and \`accessRoutes\` in
\`src/auth/access.ts\` verifies the identity that Access forwards. In bearer mode,
\`src/auth/bearer.ts\` checks a static token instead.`;
const ACCESS_MCP_PROPS = `With Cloudflare Access sign-in, \`accessProps()\` in \`src/auth/access.ts\` creates the props for
each request. \`id\` and \`login\` are the email that Access verified, in lowercase, \`name\` is the
name that Access reports or the email, \`scopes\` holds every scope, and there's no \`accessToken\`.`;
const ACCESS_HOST_CHECK = `\`createMcpApiHandler()\` in \`src/mcp/handler.ts\` checks the \`Host\` header only on \`localhost\` and
\`workers.dev\` by default. To apply the check on the custom domain, pass \`allowedHostnames\` where
\`src/auth/access.ts\` creates the handler. Run \`pnpm test\` afterward, because the tests send
requests to \`localhost\`.`;
const ACCESS_PREVIEW_MCP = `With Cloudflare Access sign-in, MCP sign-in doesn't work on a Preview. The Access application
doesn't cover Preview hostnames, and the Worker serves MCP only to an identity that Access
forwards, so the Worker answers \`/mcp\` with \`401\`. If Worker-level Access protects the
Previews, Access answers \`/mcp\` instead of the Worker.`;
const ACCESS_CUSTOM_DOMAIN = `With Cloudflare Access sign-in, create the Access application on the custom domain, as
[auth.md](auth.md#access-layouts) describes.`;
const ACCESS_WEB_BOTH = `### Both halves

With Cloudflare Access sign-in, one allow application can cover both halves, as the
[Access layouts](auth.md#access-layouts) describe. A private web app uses the host layout, and a
public web app uses the path layout.`;
const ACCESS_MCP_NO_UPSTREAM_TOKEN = `Bearer mode and Cloudflare Access sign-in have no upstream token, so this tool's GitHub call
always fails there with "This connection has no GitHub token." In those modes, follow the same
steps with a handler that uses only its input and this Worker's bindings, as
\`example_echo_message\` and \`account_record_visit\` do.`;
const ACCESS_ONLY_LAYOUT = `Use the host layout: the allow application covers the whole hostname. Access serves
\`/.well-known/oauth-protected-resource\`, \`/.well-known/oauth-protected-resource/mcp\`, and
\`/.well-known/oauth-authorization-server\` itself. Add a bypass application on \`/healthz\`, as
\`bypass-app.json\` shows, so the deploy workflow's health check reaches the Worker.`;
const ACCESS_AUTH_INTRO = `MCP clients sign in through Cloudflare Access. [Bearer mode](#bearer-mode) replaces it with one
static token for a single user.`;

const FRAGMENTS: Record<Fragment, FragmentSpec> = {
  "no-web": {
    dropKinds: ["web"],
    paths: [
      { path: "src/web" },
      { path: "src/http/routes/api.ts" },
      { path: "react-router.config.ts" },
      { path: "test/web" },
      { path: "test/http/api.test.ts" },
      { path: "docs/web.md" },
    ],
    dependencies: [
      "react",
      "react-dom",
      "react-router",
      "@react-router/dev",
      "@types/react",
      "@types/react-dom",
      "isbot",
    ],
    dependenciesIfUnused: [],
    scripts: {
      dev: { from: "react-router dev", to: "vite dev" },
      build: { from: "react-router build", to: "vite build" },
      typegen: {
        from: "wrangler types --strict-vars=false && react-router typegen",
        to: "wrangler types --strict-vars=false",
      },
    },
    // The rule that keeps MCP code apart from the web app means nothing without the web app. Its
    // lint override only adds the web app's imports to the root rule, so it goes too.
    swaps: [
      { file: "docs/deploy.md", anchor: "go to `build/server/`", content: MCP_ONLY_BUILD_OUTPUT },
      { file: AGENTS, anchor: "never import `src/web`", content: "" },
      { file: "docs/conventions.md", anchor: "never import `src/web`", content: "" },
      { file: ".oxlintrc.json", anchor: `"files": ["src/mcp/**", "src/auth/**"]`, content: "" },
      {
        file: "src/http/access.ts",
        anchor: "import { HttpError, UpstreamError }",
        content: MCP_ONLY_ACCESS_ERRORS_IMPORT,
      },
    ],
    swapsCover: [],
  },
  "no-mcp": {
    dropKinds: ["mcp", "oauth"],
    paths: [
      { path: "src/mcp" },
      { path: "src/auth" },
      { path: "src/env.ts" },
      { path: "test/mcp" },
      { path: "test/auth" },
      { path: "test/helpers/mcp.ts" },
      { path: "test/helpers/oauth.ts" },
      { path: "docs/mcp.md" },
      { path: "docs/auth.md" },
    ],
    dependencies: ["agents", "@modelcontextprotocol/server", "@cloudflare/workers-oauth-provider"],
    dependenciesIfUnused: ["zod"],
    scripts: {},
    swaps: [
      { file: "src/worker.ts", anchor: "createProviderCache(", content: APP_WORKER_HANDLER },
      {
        file: "test/http/healthz.test.ts",
        anchor: "Cross-Origin-Opener-Policy",
        content: DEFAULT_OPENER_POLICY_TEST,
      },
    ],
    swapsCover: [],
  },
  // Bearer mode keeps `src/auth/access.ts`, which the template ships next to the OAuth code, so a
  // project with the web app can still switch to Access sign-in. `no-access` deletes it otherwise.
  bearer: {
    dropKinds: ["oauth"],
    paths: [
      { path: "src/auth", keep: ["src/auth/bearer.ts", "src/auth/access.ts"] },
      { path: "test/auth", keep: ["test/auth/access.test.ts"] },
      { path: "test/helpers/oauth.ts" },
    ],
    dependencies: ["@cloudflare/workers-oauth-provider"],
    dependenciesIfUnused: [],
    scripts: {},
    swaps: [
      { file: "src/worker.ts", anchor: "OAuth provider first", content: BEARER_WORKER_HEADER },
      { file: "src/worker.ts", anchor: `"#auth/provider.ts"`, content: BEARER_WORKER_IMPORT },
      { file: "src/worker.ts", anchor: `"#lib/log.ts"`, content: BEARER_WORKER_ROUTE_IMPORT },
      { file: "src/worker.ts", anchor: "createProviderCache(", content: BEARER_WORKER_HANDLER },
      { file: "wrangler.jsonc", anchor: `"GITHUB_CLIENT_ID"`, content: BEARER_WRANGLER_SECRETS },
      { file: ".dev.vars.example", anchor: "GITHUB_CLIENT_ID=", content: BEARER_DEV_VARS },
      {
        file: "test/http/healthz.test.ts",
        anchor: "Cross-Origin-Opener-Policy",
        content: DEFAULT_OPENER_POLICY_TEST,
      },
      { file: "src/env.ts", anchor: "See your GitHub login", content: BEARER_SCOPE_DESCRIPTIONS },
      { file: "src/env.ts", anchor: "`accessToken` is the user's", content: BEARER_ACCESS_TOKEN },
      {
        file: "docs/mcp.md",
        anchor: "validates the token and calls",
        content: BEARER_MCP_TOKEN_CHECK,
      },
      { file: "docs/deploy.md", anchor: "pass `allowedHostnames`", content: BEARER_HOST_CHECK },
      { file: "docs/web.md", anchor: "<name> MCP and OAuth", content: BEARER_ACCESS_BYPASS },
      {
        file: AGENTS,
        anchor: "The OAuth provider in `src/auth` guards it",
        content: BEARER_AGENTS_INTRO,
      },
      {
        file: "docs/auth.md",
        anchor: "MCP clients sign in through OAuth.",
        content: BEARER_AUTH_INTRO,
      },
      { file: README, anchor: "sign in with GitHub through OAuth", content: BEARER_README_INTRO },
      { file: README, anchor: "**OAuth.**", content: BEARER_README_FEATURE },
      { file: README, anchor: "set up GitHub OAuth before", content: BEARER_README_LOCAL },
      {
        file: README,
        anchor: "consent page and the GitHub sign-in",
        content: BEARER_README_CLIENT,
      },
    ],
    swapsCover: ["src/worker.ts"],
  },
  // Access sign-in keeps `src/auth/bearer.ts`, as every MCP selection does.
  "access-sign-in": {
    dropKinds: ["oauth"],
    paths: [
      { path: "src/auth", keep: ["src/auth/bearer.ts", "src/auth/access.ts"] },
      { path: "test/auth", keep: ["test/auth/access.test.ts"] },
      { path: "test/helpers/oauth.ts" },
    ],
    dependencies: ["@cloudflare/workers-oauth-provider"],
    dependenciesIfUnused: [],
    scripts: {},
    swaps: [
      { file: "src/worker.ts", anchor: "OAuth provider first", content: ACCESS_WORKER_HEADER },
      { file: "src/worker.ts", anchor: `"#auth/provider.ts"`, content: "" },
      { file: "src/worker.ts", anchor: `"#lib/log.ts"`, content: "" },
      { file: "src/worker.ts", anchor: "createProviderCache(", content: APP_WORKER_HANDLER },
      { file: "src/http/index.ts", anchor: `"#auth/routes.ts"`, content: ACCESS_ROUTES_IMPORT },
      { file: "src/http/index.ts", anchor: "authRoutes);", content: ACCESS_ROUTES_MOUNT },
      {
        file: "test/http/healthz.test.ts",
        anchor: "Cross-Origin-Opener-Policy",
        content: DEFAULT_OPENER_POLICY_TEST,
      },
      { file: "src/env.ts", anchor: "See your GitHub login", content: ACCESS_SCOPE_DESCRIPTIONS },
      { file: "src/env.ts", anchor: "`accessToken` is the user's", content: ACCESS_ACCESS_TOKEN },
      {
        file: ".dev.vars.example",
        anchor: "Wrangler ignores a key here",
        content: ACCESS_DEV_VARS,
      },
      {
        file: AGENTS,
        anchor: "The OAuth provider in `src/auth` guards it",
        content: ACCESS_AGENTS_INTRO,
      },
      {
        file: AGENTS,
        anchor: "loads a `.dev.vars` key only if",
        content: ACCESS_AGENTS_MCP_INVARIANTS,
      },
      {
        file: AGENTS,
        anchor: "read the provider's helpers",
        content: ACCESS_AGENTS_INVARIANTS,
      },
      { file: README, anchor: "sign in with GitHub through OAuth", content: ACCESS_README_INTRO },
      { file: README, anchor: "**OAuth.**", content: ACCESS_README_FEATURE },
      { file: README, anchor: "set up GitHub OAuth before", content: ACCESS_README_LOCAL },
      { file: README, anchor: "protected resource metadata.", content: ACCESS_README_ENDPOINTS },
      {
        file: README,
        anchor: "consent page and the GitHub sign-in",
        content: ACCESS_README_CLIENT,
      },
      {
        file: "docs/mcp.md",
        anchor: "validates the token and calls",
        content: ACCESS_MCP_TOKEN_CHECK,
      },
      { file: "docs/mcp.md", anchor: "creates the props when it calls", content: ACCESS_MCP_PROPS },
      { file: "docs/deploy.md", anchor: "pass `allowedHostnames`", content: ACCESS_HOST_CHECK },
      { file: "docs/deploy.md", anchor: "`resource_metadata`, so", content: ACCESS_PREVIEW_MCP },
      {
        file: "docs/deploy.md",
        anchor: "also set `MCP_RESOURCE` in the top-level",
        content: ACCESS_CUSTOM_DOMAIN,
      },
      { file: "docs/web.md", anchor: "### Both halves on one hostname", content: ACCESS_WEB_BOTH },
      { file: "docs/web.md", anchor: "### Both halves on two hostnames", content: "" },
      { file: "docs/web.md", anchor: "also answer on `mcp.example.com`", content: "" },
      {
        file: "docs/auth.md",
        anchor: "is an alternative mode that this project",
        content: ACCESS_AUTH_INTRO,
      },
      { file: "docs/auth.md", anchor: "nothing mounts `accessRoutes`", content: "" },
      {
        file: "docs/mcp.md",
        anchor: "has no upstream token, so this tool's",
        content: ACCESS_MCP_NO_UPSTREAM_TOKEN,
      },
    ],
    swapsCover: ["src/worker.ts"],
  },
  // Without the web app, Access sign-in has one layout, so the layout choice goes.
  "access-without-web": {
    dropKinds: [],
    paths: [],
    dependencies: [],
    dependenciesIfUnused: [],
    scripts: {},
    swaps: [
      {
        file: "docs/auth.md",
        anchor: "Pick the layout that fits the web app",
        content: ACCESS_ONLY_LAYOUT,
      },
    ],
    swapsCover: [],
  },
  // Without the web app and without Access sign-in, nothing checks an Access identity.
  "no-access": {
    dropKinds: ["access"],
    paths: [
      { path: "src/http/access.ts" },
      { path: "src/auth/access.ts" },
      { path: "test/http/access.test.ts" },
      { path: "test/auth/access.test.ts" },
      { path: "test/helpers/access.ts" },
    ],
    dependencies: ["jose"],
    dependenciesIfUnused: [],
    scripts: {},
    swaps: [{ file: "docs/auth.md", anchor: "Don't reuse `ACCESS_TEAM_DOMAIN`", content: "" }],
    swapsCover: [],
  },
};

// The selection that each single-variant command stands for.
const VARIANTS: Record<Variant, { summary: string; selection: Selection }> = {
  "mcp-only": {
    summary: "Keep the MCP endpoint with GitHub OAuth and drop the web app.",
    selection: { parts: new Set(["mcp"]), signIn: "github" },
  },
  "app-only": {
    summary: "Keep the web app and drop the MCP endpoint and its OAuth flow.",
    selection: { parts: new Set(["web"]), signIn: undefined },
  },
  bearer: {
    summary: "Keep both parts and replace MCP OAuth with one static bearer token.",
    selection: { parts: new Set(["mcp", "web"]), signIn: "bearer" },
  },
};

// The fragments that a selection applies. The Access identity check goes only when neither the
// web app nor Access sign-in needs it.
function fragmentsFor(selection: Selection): Fragment[] {
  const fragments: Fragment[] = [];
  const web = selection.parts.has("web");
  if (!web) {
    fragments.push("no-web");
  }
  if (!selection.parts.has("mcp")) {
    fragments.push("no-mcp");
  }
  if (selection.signIn === "bearer") {
    fragments.push("bearer");
  }
  if (selection.signIn === "access") {
    fragments.push("access-sign-in");
    if (!web) {
      fragments.push("access-without-web");
    }
  }
  if (!web && selection.signIn !== "access") {
    fragments.push("no-access");
  }
  return fragments;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// Combines fragments into one set of changes. A path or a dependency that two fragments list is
// handled once.
function mergeFragments(fragments: readonly Fragment[]): FragmentSpec {
  const specs = fragments.map((fragment) => FRAGMENTS[fragment]);
  return {
    dropKinds: distinct(specs.flatMap((spec) => spec.dropKinds)),
    paths: specs.flatMap((spec) => spec.paths),
    dependencies: distinct(specs.flatMap((spec) => spec.dependencies)),
    dependenciesIfUnused: distinct(specs.flatMap((spec) => spec.dependenciesIfUnused)),
    scripts: Object.fromEntries(specs.flatMap((spec) => Object.entries(spec.scripts))),
    swaps: specs.flatMap((spec) => spec.swaps),
    swapsCover: distinct(specs.flatMap((spec) => spec.swapsCover)),
  };
}

const FINISH_EDITS: TextEdit[] = [
  {
    file: "wrangler.jsonc",
    description: "remove the header sentence about markers",
    apply: (text) => removeHeaderSentence(text, "Blocks between"),
  },
  {
    file: "renovate.json5",
    description: "remove the header sentence about markers",
    apply: (text) => removeHeaderSentence(text, "Blocks between"),
  },
  {
    file: ".github/workflows/ci.yml",
    description: "remove the setup job",
    apply: removeSetupJob,
  },
  {
    file: ".gitignore",
    description: "remove the entry for the setup state",
    apply: removeSetupIgnore,
  },
];

function isKind(name: string): name is Kind {
  return KINDS.has(name);
}

function isVariant(name: string): name is Variant {
  return Object.hasOwn(VARIANTS, name);
}

function isPart(name: string): name is Part {
  return PARTS.has(name);
}

function isSignIn(name: string): name is SignIn {
  return SIGN_INS.has(name);
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

// Thrown for any check that fails while the script plans its changes.
class PruneError extends Error {
  override readonly name = "PruneError";
}

// An in-memory view of the tree. Reads see earlier planned writes and deletions, and nothing
// reaches the disk until `commit`.
class Workspace {
  readonly #writes = new Map<string, string>();
  readonly #deletions: string[] = [];

  read(file: string): string {
    if (this.isDeleted(file)) {
      throw new PruneError(`${file} is deleted by this run, so it can't be edited.`);
    }
    return this.#writes.get(file) ?? readFileSync(path.join(ROOT, file), "utf8");
  }

  write(file: string, text: string): void {
    if (text !== this.read(file)) {
      this.#writes.set(file, text);
    }
  }

  delete(file: string): void {
    this.#deletions.push(file);
    for (const written of this.#writes.keys()) {
      if (isWithin(written, file)) {
        this.#writes.delete(written);
      }
    }
  }

  isDeleted(file: string): boolean {
    return this.#deletions.some((deleted) => isWithin(file, deleted));
  }

  changedFiles(): string[] {
    return [...this.#writes.keys()].toSorted();
  }

  /** Every text file in the tree that this run hasn't deleted, as paths relative to the root. */
  textFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (this.isDeleted(rel)) {
          continue;
        }
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            walk(rel);
          }
        } else if (entry.isFile() && !SKIP_FILES.has(rel) && isText(rel)) {
          files.push(rel);
        }
      }
    };
    walk("");
    return files.toSorted();
  }

  commit(): void {
    for (const [file, text] of this.#writes) {
      writeFileSync(path.join(ROOT, file), text);
    }
    for (const file of this.#deletions) {
      rmSync(path.join(ROOT, file), { recursive: true, force: true });
    }
  }
}

function isWithin(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

function isText(file: string): boolean {
  const sample = readFileSync(path.join(ROOT, file)).subarray(0, 8000);
  return !sample.includes(0);
}

function exists(file: string): boolean {
  try {
    lstatSync(path.join(ROOT, file));
    return true;
  } catch {
    return false;
  }
}

// Whether a file is missing because an earlier run applied a fragment that deletes it, such as
// `docs/web.md` after `mcp-only`. A swap for that file has nothing to replace when `bearer` runs
// later. The fragment must list the file itself, not a directory that holds it, and every path that
// it deletes must already be gone, so a mistyped or stale swap path still fails.
function removedByEarlierVariant(file: string): boolean {
  return (
    !exists(file) &&
    Object.values(FRAGMENTS).some(
      (spec) =>
        spec.paths.some((removal) => removal.path === file && removal.keep === undefined) &&
        spec.paths.every((removal) => onlyKeptPathsRemain(removal.path, removal.keep ?? [])),
    )
  );
}

// Whether nothing in `dir` survives except the paths in `keep`, which is how the tree looks after a
// variant deletes `dir` or everything in it but `keep`.
function onlyKeptPathsRemain(dir: string, keep: readonly string[]): boolean {
  if (!exists(dir)) {
    return true;
  }
  if (keep.length === 0) {
    return false;
  }
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).every((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (keep.includes(rel)) {
      return true;
    }
    return (
      entry.isDirectory() &&
      keep.some((kept) => isWithin(kept, rel)) &&
      onlyKeptPathsRemain(rel, keep)
    );
  });
}

// Whether a path is on disk and this run hasn't planned to delete it.
function isPresent(ws: Workspace, file: string): boolean {
  return exists(file) && !ws.isDeleted(file);
}

// `removed` counts the deleted blocks by label, such as `@starter:web` or `empty @starter:mcp`.
type BlockResult = { text: string; removed: Map<string, number>; swapped: Swap[] };

// Deletes the blocks of the given kinds, applies the swaps, and drops empty blocks. With `strip`,
// it also deletes every remaining marker line and keeps the content between them.
function processBlocks(
  file: string,
  text: string,
  options: { drop: readonly Kind[]; swaps: readonly Swap[]; cover: boolean; strip: boolean },
): BlockResult {
  const lines = text.split("\n");
  const out: string[] = [];
  const seams: number[] = [];
  const removed = new Map<string, number>();
  const swapped: Swap[] = [];
  let open: { kind: Kind; line: number; body: string[]; marker: string } | undefined;

  const closeBlock = (
    block: { kind: Kind; line: number; body: string[]; marker: string },
    end: string,
  ) => {
    const body = block.body.join("\n");
    const matches = options.swaps.filter((swap) => body.includes(swap.anchor));
    if (matches.length > 1) {
      throw new PruneError(`${file}:${block.line}: more than one swap matches this block.`);
    }
    const [swap] = matches;
    if (swap !== undefined) {
      swapped.push(swap);
      if (swap.content === "") {
        seams.push(out.length);
      } else {
        out.push(...swap.content.split("\n"));
      }
    } else if (options.cover && (block.kind === "mcp" || block.kind === "oauth")) {
      throw new PruneError(
        `${file}:${block.line}: no swap covers this @starter:${block.kind} block, so its code would survive.`,
      );
    } else if (
      options.drop.includes(block.kind) ||
      block.body.every((line) => line.trim() === "")
    ) {
      const label = `${options.drop.includes(block.kind) ? "" : "empty "}@starter:${block.kind}`;
      removed.set(label, (removed.get(label) ?? 0) + 1);
      seams.push(out.length);
    } else if (options.strip) {
      seams.push(out.length);
      out.push(...block.body);
      seams.push(out.length);
    } else {
      out.push(block.marker, ...block.body, end);
    }
  };

  lines.forEach((line, index) => {
    const match = MARKER.exec(line);
    const name = match?.[1];
    if (name === undefined) {
      if (open === undefined) {
        out.push(line);
      } else {
        open.body.push(line);
      }
      return;
    }
    const where = `${file}:${index + 1}`;
    if (name === "end") {
      if (open === undefined) {
        throw new PruneError(`${where}: @starter:end has no open block.`);
      }
      closeBlock(open, line);
      open = undefined;
      return;
    }
    if (!isKind(name)) {
      throw new PruneError(`${where}: unknown marker @starter:${name}.`);
    }
    if (open !== undefined) {
      throw new PruneError(
        `${where}: @starter:${name} opens inside the block from line ${open.line}. Blocks don't nest.`,
      );
    }
    open = { kind: name, line: index + 1, body: [], marker: line };
  });
  if (open !== undefined) {
    throw new PruneError(`${file}:${open.line}: @starter:${open.kind} is never closed.`);
  }
  return { text: tidySeams(out, seams).join("\n"), removed, swapped };
}

// Removing lines can leave blank lines that the formatter would delete: two in a row, one at the
// start or end of a bracketed body, or one at the start or end of the file. This deletes them at
// each place where lines were removed.
function tidySeams(lines: string[], seams: number[]): string[] {
  const out = [...lines];
  const unique = [...new Set(seams)].toSorted((a, b) => b - a);
  for (const seam of unique) {
    const before = out[seam - 1];
    const after = out[seam];
    if (isBlank(before) && isBlank(after)) {
      out.splice(seam, 1);
    } else if (isBlank(after) && (seam === 0 || /[[{(]$/.test(before ?? ""))) {
      out.splice(seam, 1);
    } else if (isBlank(before) && (/^\s*[\]})]/.test(after ?? "") || seam === out.length - 1)) {
      out.splice(seam - 1, 1);
    }
  }
  return out;
}

// The formatter prints an array of literals on one line when it fits. Removing a block from a
// multi-line array can leave one that fits, so this joins it the same way.
function collapseArrays(text: string, printWidth: number): string {
  const array =
    /^([ \t]*)((?:"[^"\n]*"|[A-Za-z_$][\w$]*)\s*:\s*)?\[\n((?:[ \t]*(?:"[^"\n]*"|-?\d+(?:\.\d+)?|true|false|null),?\n)*)[ \t]*\](,?)$/gm;
  return text.replace(
    array,
    (whole, indent: string, key: string | undefined, items: string, comma: string) => {
      const values = items
        .split("\n")
        .map((item) => item.trim().replace(/,$/, ""))
        .filter((item) => item !== "");
      const line = `${indent}${key ?? ""}[${values.join(", ")}]${comma}`;
      return line.length <= printWidth ? line : whole;
    },
  );
}

// Deletes one sentence from the comment block at the top of a file and rewraps the block.
function removeHeaderSentence(text: string, start: string): string {
  const lines = text.split("\n");
  const count = lines.findIndex((line) => !line.startsWith("//"));
  const header = lines
    .slice(0, count)
    .map((line) => line.replace(/^\/\/ ?/, ""))
    .join(" ");
  const sentence = new RegExp(`\\s*${start}[^.]*\\.`);
  if (!sentence.test(header)) {
    throw new PruneError(`expected a header sentence that starts with "${start}".`);
  }
  const wrapped = wrapComment(header.replace(sentence, "").trim(), "// ", readPrintWidth());
  return [...wrapped, ...lines.slice(count)].join("\n");
}

function wrapComment(prose: string, prefix: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of prose.split(/\s+/)) {
    if (line !== "" && prefix.length + line.length + 1 + word.length > width) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") {
    lines.push(prefix + line);
  }
  return lines;
}

// Names the halves that the tree keeps, in the form that `AGENTS.md` uses. The tree tells which
// selection ran, so `--finish` works the same whether it runs with the selection or later.
function describeHalves(ws: Workspace): string {
  const halves: string[] = [];
  if (isPresent(ws, "src/mcp")) {
    halves.push(`MCP endpoint (${describeSignIn(ws)})`);
  }
  if (isPresent(ws, "src/web")) {
    halves.push("web app");
  }
  if (halves.length === 0) {
    throw new PruneError("neither src/mcp nor src/web exists, so no half is left to describe.");
  }
  return `${HALVES_PREFIX} ${halves.join(", ")}.`;
}

// Names the MCP sign-in mode. Bearer mode with the web app keeps `src/auth/access.ts` unused, so
// Access sign-in shows in the module that mounts its routes, not in which files exist.
function describeSignIn(ws: Workspace): string {
  if (isPresent(ws, "src/auth/provider.ts")) {
    return "OAuth";
  }
  const app = "src/http/index.ts";
  if (isPresent(ws, app) && ws.read(app).includes(`from "#auth/access.ts"`)) {
    return "Cloudflare Access";
  }
  return "bearer token";
}

// Replaces the one line that starts with `Halves present:`.
function rewriteHalvesLine(text: string, line: string): string {
  const lines = text.split("\n");
  const matches = lines.filter((candidate) => candidate.startsWith(HALVES_PREFIX)).length;
  if (matches !== 1) {
    throw new PruneError(
      `expected exactly one line that starts with "${HALVES_PREFIX}", found ${matches}.`,
    );
  }
  const index = lines.findIndex((candidate) => candidate.startsWith(HALVES_PREFIX));
  lines[index] = line;
  return lines.join("\n");
}

// Deletes the one line that mentions `SETUP.md`, if there is one. More than one is an error,
// because deleting several lines could cut a paragraph apart.
function removeSetupPointer(text: string): string {
  const lines = text.split("\n");
  const pointers = lines.flatMap((line, index) => (line.includes(SETUP) ? [index] : []));
  if (pointers.length > 1) {
    throw new PruneError(
      `expected at most one line that mentions ${SETUP}, found ${pointers.length}: lines ${pointers.map((index) => index + 1).join(", ")}.`,
    );
  }
  const [index] = pointers;
  if (index === undefined) {
    return text;
  }
  lines.splice(index, 1);
  return tidySeams(lines, [index]).join("\n");
}

// Deletes the `setup` job, which tests the setup script and this one, and its bullet in the header
// comment. The job ends where the next job, `workflows`, starts.
function removeSetupJob(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf("  setup:");
  const end = lines.indexOf("  workflows:");
  if (start === -1 || end === -1 || end < start) {
    throw new PruneError("expected a `setup:` job followed by a `workflows:` job.");
  }
  lines.splice(start, end - start);
  const bullet = lines.findIndex((line) => line.startsWith("# - `setup`"));
  if (bullet !== -1) {
    let next = bullet + 1;
    while (lines[next]?.startsWith("#   ")) {
      next++;
    }
    lines.splice(bullet, next - bullet);
  }
  return lines.join("\n");
}

// Deletes the block that says setup isn't finished, if it's there, with its markers.
function removeSetupBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(SETUP_BLOCK_START);
  if (start === -1) {
    return text;
  }
  const end = lines.indexOf(SETUP_BLOCK_END, start);
  if (end === -1) {
    throw new PruneError(`${SETUP_BLOCK_START} has no ${SETUP_BLOCK_END} after it.`);
  }
  lines.splice(start, end - start + 1);
  return tidySeams(lines, [start]).join("\n");
}

// Deletes the `.gitignore` entry for the setup state and the comment line above it.
function removeSetupIgnore(text: string): string {
  const lines = text.split("\n");
  const index = lines.indexOf(SETUP_IGNORE);
  if (index === -1) {
    return text;
  }
  const start = (lines[index - 1] ?? "").startsWith("#") ? index - 1 : index;
  lines.splice(start, index - start + 1);
  return tidySeams(lines, [start]).join("\n");
}

function readPrintWidth(): number {
  try {
    const config: unknown = JSON.parse(readFileSync(path.join(ROOT, ".oxfmtrc.json"), "utf8"));
    if (
      typeof config === "object" &&
      config !== null &&
      "printWidth" in config &&
      typeof config.printWidth === "number"
    ) {
      return config.printWidth;
    }
  } catch {
    // Without a config file the formatter uses its default width.
  }
  return 80;
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function isPackageJson(value: unknown): value is PackageJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeDependency(pkg: PackageJson, name: string): boolean {
  let found = false;
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    if (deps !== undefined && name in deps) {
      delete deps[name];
      found = true;
    }
  }
  return found;
}

function isImported(ws: Workspace, name: string): boolean {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const specifier = new RegExp(
    `(?:from\\s+|import\\s*\\(\\s*|import\\s+)["']${escaped}(?:/[^"']*)?["']`,
  );
  return ws.textFiles().some((file) => CODE_FILE.test(file) && specifier.test(ws.read(file)));
}

// Deletes everything inside `removal.path` except the paths in `removal.keep`.
function deleteExcept(
  ws: Workspace,
  dir: string,
  keep: readonly string[],
  deleted: string[],
): void {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (keep.includes(rel)) {
      continue;
    }
    if (entry.isDirectory() && keep.some((kept) => isWithin(kept, rel))) {
      deleteExcept(ws, rel, keep, deleted);
    } else {
      ws.delete(rel);
      deleted.push(rel);
    }
  }
}

// Collects the report lines for one run.
type Report = { title: string; lines: string[] }[];

function section(report: Report, title: string): string[] {
  const lines: string[] = [];
  report.push({ title, lines });
  return lines;
}

function planSelection(ws: Workspace, label: string, spec: FragmentSpec, report: Report): void {
  const errors: string[] = [];

  // A kept path may be gone already when an earlier run deleted it, such as `src/auth/access.ts`
  // after `mcp-only`, and `bearer` runs later.
  const missing = spec.paths
    .flatMap((removal) => [
      removal.path,
      ...(removal.keep ?? []).filter((kept) => !removedByEarlierVariant(kept)),
    ])
    .filter((file) => !exists(file));
  if (missing.length > 0) {
    throw new PruneError(
      `The ${label} file list names paths that don't exist:\n${missing.map((file) => `  ${file}`).join("\n")}`,
    );
  }

  const deletedPaths: string[] = [];
  for (const removal of spec.paths) {
    if (removal.keep === undefined) {
      ws.delete(removal.path);
      deletedPaths.push(removal.path);
    } else {
      deleteExcept(ws, removal.path, removal.keep, deletedPaths);
    }
  }
  section(report, "Deleted files and directories").push(...new Set(deletedPaths));

  const blocks = section(report, "Removed blocks");
  const swapped = section(report, "Swapped blocks");
  const usedSwaps = new Set<Swap>();
  for (const file of ws.textFiles()) {
    const swaps = spec.swaps.filter((swap) => swap.file === file);
    try {
      const result = processBlocks(file, ws.read(file), {
        drop: spec.dropKinds,
        swaps,
        cover: spec.swapsCover.includes(file),
        strip: false,
      });
      ws.write(file, result.text);
      for (const [blockLabel, count] of result.removed) {
        blocks.push(`${file}: ${count} ${blockLabel}`);
      }
      for (const swap of result.swapped) {
        usedSwaps.add(swap);
        swapped.push(`${file}: the block with ${swap.anchor}`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const swap of spec.swaps) {
    if (!usedSwaps.has(swap) && !ws.isDeleted(swap.file) && !removedByEarlierVariant(swap.file)) {
      errors.push(`${swap.file}: no marked block contains ${swap.anchor}.`);
    }
  }

  const pkg: unknown = JSON.parse(ws.read("package.json"));
  if (!isPackageJson(pkg)) {
    throw new PruneError("package.json doesn't hold a JSON object.");
  }
  const deps = section(report, "Removed dependencies");
  for (const name of spec.dependencies) {
    if (removeDependency(pkg, name)) {
      deps.push(name);
    } else {
      errors.push(`package.json: the dependency ${name} isn't listed.`);
    }
  }
  for (const name of spec.dependenciesIfUnused) {
    if (isImported(ws, name)) {
      deps.push(`${name} kept, because a remaining file imports it`);
    } else if (removeDependency(pkg, name)) {
      deps.push(name);
    }
  }
  const scripts = section(report, "Rewritten package.json scripts");
  for (const [name, { from, to }] of Object.entries(spec.scripts)) {
    if (pkg.scripts?.[name] !== from) {
      errors.push(`package.json: expected the ${name} script to be "${from}".`);
      continue;
    }
    pkg.scripts[name] = to;
    scripts.push(`${name}: ${to}`);
  }
  ws.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

  if (errors.length > 0) {
    throw new PruneError(
      `The ${label} selection can't be applied:\n${errors.map((error) => `  ${error}`).join("\n")}`,
    );
  }
}

function planFinish(ws: Workspace, report: Report): void {
  const errors: string[] = [];
  const stripped = section(report, "Stripped markers");
  for (const file of ws.textFiles()) {
    try {
      const result = processBlocks(file, ws.read(file), {
        drop: [],
        swaps: [],
        cover: false,
        strip: true,
      });
      if (result.text !== ws.read(file)) {
        ws.write(file, result.text);
        stripped.push(file);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const edited = section(report, "Text edits");
  const notices = section(report, "Notices");
  const edits = [...FINISH_EDITS];
  if (isPresent(ws, AGENTS)) {
    edits.push({
      file: AGENTS,
      description: "list the halves that remain on the Halves present line",
      apply: (text) => rewriteHalvesLine(text, describeHalves(ws)),
    });
    edits.push({
      file: AGENTS,
      description: "remove the block that says setup isn't finished",
      apply: removeSetupBlock,
    });
  } else {
    notices.push(`${AGENTS} doesn't exist, so no Halves present line was rewritten.`);
  }
  if (isPresent(ws, README)) {
    edits.push({
      file: README,
      description: `remove the line that points to ${SETUP}`,
      apply: removeSetupPointer,
    });
  }
  for (const edit of edits) {
    try {
      const text = ws.read(edit.file);
      const next = edit.apply(text);
      if (next !== text) {
        ws.write(edit.file, next);
        edited.push(`${edit.file}: ${edit.description}`);
      }
    } catch (error) {
      errors.push(
        `${edit.file}: ${edit.description}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const deleted = section(report, "Deleted files and directories");
  if (isPresent(ws, SETUP)) {
    ws.delete(SETUP);
    deleted.push(SETUP);
    for (const file of ws.textFiles()) {
      if (ws.read(file).includes(SETUP)) {
        notices.push(`${file} still mentions ${SETUP}, which this run deleted.`);
      }
    }
  }
  for (const file of SETUP_FILES) {
    if (isPresent(ws, file)) {
      ws.delete(file);
      deleted.push(file);
    }
  }
  ws.delete(SELF);
  deleted.push(SELF);

  const leftovers = ws.textFiles().filter((file) => ws.read(file).includes("@starter:"));
  for (const file of leftovers) {
    errors.push(`${file} still mentions @starter:. Remove the mention and run --finish again.`);
  }
  if (errors.length > 0) {
    throw new PruneError(
      `--finish can't be applied:\n${errors.map((error) => `  ${error}`).join("\n")}`,
    );
  }
}

// Formats every changed file the way the formatter would after lines were removed.
function collapseChanged(ws: Workspace): void {
  const width = readPrintWidth();
  for (const file of ws.changedFiles()) {
    if (COLLAPSIBLE_FILE.test(file)) {
      ws.write(file, collapseArrays(ws.read(file), width));
    }
  }
}

// Deletes directories that the run left empty, deepest first.
function removeEmptyDirectories(dir = ""): string[] {
  const removed: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      removed.push(...removeEmptyDirectories(rel));
      if (readdirSync(path.join(ROOT, rel)).length === 0) {
        rmdirSync(path.join(ROOT, rel));
        removed.push(rel);
      }
    }
  }
  return removed;
}

function usage(message?: string): never {
  console.error(
    [
      ...(message === undefined ? [] : [message, ""]),
      "Usage: node scripts/prune.ts --parts <mcp,web|mcp|web> [--sign-in <mode>] [--finish]",
      "       node scripts/prune.ts <variant> [--finish]",
      "       node scripts/prune.ts --finish",
      "",
      "--parts lists the parts to keep. --sign-in is required with mcp and not allowed without it:",
      "  github    MCP clients sign in with GitHub through OAuth.",
      "  bearer    MCP clients send one static bearer token.",
      "  access    MCP clients sign in through Cloudflare Access.",
      "",
      "Variants, one per run:",
      ...Object.entries(VARIANTS).map(([name, spec]) => `  ${name.padEnd(9)} ${spec.summary}`),
      "",
      "--finish strips the remaining markers, rewrites the Halves present line in AGENTS.md, and",
      "deletes SETUP.md, its pointer in README.md, the setup script and its state, the setup block",
      "in AGENTS.md, the setup job, and this script.",
    ].join("\n"),
  );
  process.exit(2);
}

type Args = { selection: Selection | undefined; label: string | undefined; finish: boolean };

function parseParts(value: string | undefined): Set<Part> {
  const names = (value ?? "").split(",").map((name) => name.trim());
  const parts = new Set<Part>();
  for (const name of names) {
    if (!isPart(name) || parts.has(name)) {
      usage(`--parts takes mcp, web, or both, separated by a comma, not "${value ?? ""}".`);
    }
    parts.add(name);
  }
  return parts;
}

function parseArgs(args: string[]): Args {
  let variant: Variant | undefined;
  let parts: Set<Part> | undefined;
  let signIn: SignIn | undefined;
  let finish = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--finish") {
      finish = true;
    } else if (arg === "--parts" && parts === undefined) {
      index++;
      parts = parseParts(args[index]);
    } else if (arg === "--sign-in" && signIn === undefined) {
      index++;
      const value = args[index] ?? "";
      if (!isSignIn(value)) {
        usage(`--sign-in takes github, bearer, or access, not "${value}".`);
      }
      signIn = value;
    } else if (variant === undefined && isVariant(arg)) {
      variant = arg;
    } else {
      usage();
    }
  }
  if (variant !== undefined) {
    if (parts !== undefined || signIn !== undefined) {
      usage("A variant can't be combined with --parts or --sign-in.");
    }
    return { selection: VARIANTS[variant].selection, label: variant, finish };
  }
  if (parts === undefined) {
    if (signIn !== undefined) {
      usage("--sign-in needs --parts.");
    }
    if (!finish) {
      usage();
    }
    return { selection: undefined, label: undefined, finish };
  }
  if (parts.has("mcp") !== (signIn !== undefined)) {
    usage("Pass --sign-in exactly when --parts includes mcp.");
  }
  const label = [`--parts ${[...parts].join(",")}`, signIn && `--sign-in ${signIn}`]
    .filter(Boolean)
    .join(" ");
  return { selection: { parts, signIn }, label, finish };
}

function main(): void {
  const { selection, label, finish } = parseArgs(process.argv.slice(2));
  const ws = new Workspace();
  const report: Report = [];
  try {
    if (selection !== undefined && label !== undefined) {
      planSelection(ws, label, mergeFragments(fragmentsFor(selection)), report);
    }
    if (finish) {
      planFinish(ws, report);
    }
    collapseChanged(ws);
  } catch (error) {
    if (error instanceof PruneError) {
      console.error(`${error.message}\n\nNothing was changed.`);
      process.exit(1);
    }
    throw error;
  }

  const written = section(report, "Edited files");
  written.push(...ws.changedFiles());
  ws.commit();
  section(report, "Removed empty directories").push(...removeEmptyDirectories());

  const steps = [label, finish ? "--finish" : undefined].filter((step) => step !== undefined);
  console.log(`Pruned with ${steps.join(" ")}.`);
  for (const { title, lines } of report) {
    if (lines.length > 0) {
      console.log(`\n${title}:\n${lines.map((line) => `  ${line}`).join("\n")}`);
    }
  }
  console.log(
    finish
      ? "\nNext, run `pnpm install` and `pnpm verify`."
      : "\nNext, run `pnpm install` to update the lockfile, then `pnpm verify`.",
  );
}

main();
