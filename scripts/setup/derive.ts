// Values that follow from the answers and the facts, such as the hostname, the account, and the
// Access applications that the project needs. The planner, the questions, the tasks, and the steps
// all read them from here, so each rule lives in one place.
import type { Answers, Context, Part, SignIn } from "./types.ts";

/** The template's repository, which setup refuses to run in. */
export const TEMPLATE_REPOSITORY = "mckalexee/cloudflare-starter";

/** The parts that the answers keep, or `undefined` before the parts question is answered. */
export function parts(answers: Answers): Part[] | undefined {
  const value = answers.parts;
  if (value === undefined) {
    return undefined;
  }
  return value.split(",").filter((part): part is Part => part === "mcp" || part === "web");
}

/** Whether the answers keep the MCP endpoint. */
export function hasMcp(answers: Answers): boolean {
  return parts(answers)?.includes("mcp") ?? false;
}

/** Whether the answers keep the web app. */
export function hasWeb(answers: Answers): boolean {
  return parts(answers)?.includes("web") ?? false;
}

/** The MCP sign-in mode, or `undefined` without the MCP endpoint or before the answer. */
export function signIn(answers: Answers): SignIn | undefined {
  if (!hasMcp(answers)) {
    return undefined;
  }
  const value = answers["sign-in"];
  return value === "github" || value === "bearer" || value === "access" ? value : undefined;
}

/** Whether the web app is private. */
export function webPrivate(answers: Answers): boolean {
  return hasWeb(answers) && answers["web-access"] === "private";
}

/** Whether Cloudflare Access protects anything: a private web app, or Access sign-in for MCP. */
export function accessUsed(answers: Answers): boolean {
  return webPrivate(answers) || signIn(answers) === "access";
}

/**
 * Whether the project needs a custom domain. A private web app next to GitHub OAuth or bearer
 * mode leaves the MCP paths open with a bypass application, which needs a hostname on a zone.
 */
export function needsCustomDomain(answers: Answers): boolean {
  const mode = signIn(answers);
  return webPrivate(answers) && (mode === "github" || mode === "bearer");
}

/** Whether the hostname answer names a custom domain instead of `workers.dev`. */
export function customDomain(answers: Answers): boolean {
  const value = answers.hostname;
  return value !== undefined && value !== "workers.dev";
}

/** The Cloudflare account: the answer, or the only account that Wrangler can reach. */
export function accountId(ctx: Context): string | undefined {
  const answer = ctx.answers["cloudflare-account"];
  if (answer !== undefined) {
    return answer;
  }
  const accounts = ctx.facts.wrangler?.accounts ?? [];
  return accounts.length === 1 ? accounts[0]?.id : undefined;
}

/** The chosen account's name, for messages, or its ID when the name is unknown. */
export function accountLabel(ctx: Context): string {
  const id = accountId(ctx);
  const account = ctx.facts.wrangler?.accounts.find((candidate) => candidate.id === id);
  return account === undefined
    ? (id ?? "the Cloudflare account")
    : `${account.name} (${account.id})`;
}

/** The account's `workers.dev` subdomain: the one it has, or the one the person chose for it. */
export function workersSubdomain(ctx: Context): string | undefined {
  return ctx.facts.workersSubdomain ?? ctx.answers["workers-subdomain"];
}

/** The production hostname, or `undefined` until the answers and facts settle it. */
export function host(ctx: Context): string | undefined {
  const value = ctx.answers.hostname;
  if (value === undefined) {
    return undefined;
  }
  if (value !== "workers.dev") {
    return value;
  }
  const subdomain = workersSubdomain(ctx);
  return subdomain === undefined ? undefined : `${ctx.repo.origin.name}.${subdomain}.workers.dev`;
}

/** The zone that holds a custom hostname, if the account has one. */
export function zoneFor(ctx: Context, hostname: string): { id: string; name: string } | undefined {
  return ctx.facts.zones.find(
    (zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`),
  );
}

/** Splits a comma-separated answer into trimmed, nonempty entries. */
export function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * The allow rules for "who may sign in", in the form that `AccessAppFact.include` uses. An entry
 * with `@` is an email address, and any other entry is an email domain.
 */
export function signInRules(value: string | undefined): string[] {
  return list(value)
    .map((entry) => entry.toLowerCase())
    .map((entry) => (entry.includes("@") ? `email:${entry}` : `domain:${entry}`))
    .toSorted();
}

/** One Access application that the project needs. */
export type DesiredAccessApp = {
  name: string;
  domain: string;
  destinations: string[];
  include: string[];
  managedOAuth: boolean;
};

/**
 * The Access applications that the answers call for, as `docs/auth.md` and `docs/web.md`
 * describe them: an allow application, and a bypass application on the public paths. Access
 * sign-in next to a public web app covers only `/mcp`, so it needs no bypass application.
 * Returns `null` when the project doesn't use Access or the hostname isn't settled yet.
 */
export function desiredAccessApps(
  ctx: Context,
): { allow: DesiredAccessApp; bypass: DesiredAccessApp | null } | null {
  const hostname = host(ctx);
  if (!accessUsed(ctx.answers) || hostname === undefined) {
    return null;
  }
  const name = ctx.repo.origin.name;
  const mode = signIn(ctx.answers);
  const include = signInRules(ctx.answers["who-may-sign-in"]);
  if (mode === "access" && !webPrivate(ctx.answers)) {
    return {
      allow: {
        name,
        domain: `${hostname}/mcp`,
        destinations: [`${hostname}/mcp`],
        include,
        managedOAuth: true,
      },
      bypass: null,
    };
  }
  const publicPaths = ["/healthz"];
  if (mode === "bearer") {
    publicPaths.push("/mcp");
  }
  if (mode === "github") {
    publicPaths.push("/mcp", "/authorize", "/token", "/register", "/callback", "/.well-known/*");
  }
  const destinations = publicPaths.map((path) => `${hostname}${path}`);
  return {
    allow: {
      name,
      domain: hostname,
      destinations: [hostname],
      include,
      managedOAuth: mode === "access",
    },
    bypass: {
      name: publicPaths.length === 1 ? `${name} health check` : `${name} public paths`,
      domain: destinations[0] ?? hostname,
      destinations,
      include: ["everyone"],
      managedOAuth: false,
    },
  };
}

/** The secret names that the production Worker needs. */
export function workerSecretNames(answers: Answers): string[] {
  const mode = signIn(answers);
  if (mode === "github") {
    return ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "COOKIE_SECRET"];
  }
  return mode === "bearer" ? ["MCP_BEARER_TOKEN"] : [];
}

/** The secret names that the Preview base config needs. */
export function previewSecretNames(answers: Answers): string[] {
  const mode = signIn(answers);
  if (mode === "github" && answers["oauth-previews"] === "yes") {
    return ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "COOKIE_SECRET"];
  }
  return mode === "bearer" ? ["MCP_BEARER_TOKEN"] : [];
}

/**
 * The `.dev.vars` keys that local development needs, split into the ones that the person writes
 * and the ones that the dev-vars step generates.
 */
export function devVarKeys(answers: Answers): { person: string[]; generated: string[] } {
  const mode = signIn(answers);
  if (mode === "github") {
    return {
      person: [
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        ...(answers["oauth-previews"] === "yes"
          ? ["PREVIEW_GITHUB_CLIENT_ID", "PREVIEW_GITHUB_CLIENT_SECRET"]
          : []),
      ],
      generated: ["COOKIE_SECRET"],
    };
  }
  return { person: [], generated: mode === "bearer" ? ["MCP_BEARER_TOKEN"] : [] };
}

/** The permissions of the API token that GitHub Actions deploys with, as `docs/deploy.md` lists. */
export function apiTokenPermissions(answers: Answers): { key: string; type: string }[] {
  return [
    { key: "workers_scripts", type: "edit" },
    ...(hasMcp(answers) ? [{ key: "workers_kv_storage", type: "edit" }] : []),
    { key: "account_settings", type: "read" },
    ...(customDomain(answers) ? [{ key: "workers_routes", type: "edit" }] : []),
  ];
}

/** The dashboard link that opens the account API token form with the permissions filled in. */
export function apiTokenLink(ctx: Context): string {
  const permissions = encodeURIComponent(JSON.stringify(apiTokenPermissions(ctx.answers)));
  const name = encodeURIComponent(`${ctx.repo.origin.name} GitHub Actions`);
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${permissions}&name=${name}`;
}

/** Title case for a project name, as the suggested display name. */
export function titleCase(name: string): string {
  return name
    .split("-")
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** A resource with the project's name whose ID `setup.json` doesn't record. */
export type Conflict = { key: "kvProduction" | "kvPreview" | "worker"; id: string; label: string };

/**
 * The KV namespaces and the Worker that carry the project's name but that setup didn't create or
 * adopt. Each needs the person's word before setup uses it. A Worker that this repository's deploy
 * job already deployed counts as the project's own.
 */
export function conflicts(ctx: Context): Conflict[] {
  const { name } = ctx.repo.origin;
  const found: Conflict[] = [];
  const { production, preview } = hasMcp(ctx.answers)
    ? ctx.facts.kvNamespaces
    : { production: null, preview: null };
  if (production !== null && ctx.resources.kvProduction !== production) {
    found.push({ key: "kvProduction", id: production, label: `the KV namespace ${name}-kv` });
  }
  if (preview !== null && ctx.resources.kvPreview !== preview) {
    found.push({ key: "kvPreview", id: preview, label: `the KV namespace ${name}-kv-preview` });
  }
  const worker = ctx.facts.worker;
  if (worker !== null && ctx.resources.worker !== worker.tag && !ctx.facts.repoDeployed) {
    found.push({ key: "worker", id: worker.tag, label: `the Worker ${name}` });
  }
  return found;
}
