// A pretend world for the planner tests: a context that starts like a fresh clone with no logins,
// and a simulated person and simulated steps that change it the way the real ones would. Running
// the planner against it walks a whole setup run without touching a repository or an account.
import {
  desiredAccessApps,
  previewSecretNames,
  signIn as signInOf,
  workerSecretNames,
} from "../derive.ts";
import { plan } from "../planner.ts";
import { EMPTY_FACTS } from "../probes.ts";
import type { Action, AnswerKey, Context, Part } from "../types.ts";

/** How the pretend accounts look before setup starts. */
export type WorldOptions = {
  accounts?: 1 | 2;
  subdomain?: boolean;
  zeroTrust?: "none" | "cloudflare-only" | "with-pin";
};

/** The answers that a scenario gives, keyed like `node scripts/setup.ts answer`. */
export type Scenario = Record<string, string>;

const ACCOUNT_A = "0123456789abcdef0123456789abcdef";
const ACCOUNT_B = "fedcba9876543210fedcba9876543210";

/** The answers that every scenario shares. A scenario's own answers override them. */
export const SHARED_ANSWERS: Scenario = {
  "display-name": "Acme Tools",
  description: "Tracks support requests for the Acme team.",
  "who-may-sign-in": "ada@example.com",
  hostname: "workers.dev",
  "allowed-github": "octocat",
  "oauth-previews": "no",
  license: "mit-0",
  "cloudflare-account": ACCOUNT_A,
  "workers-subdomain": "acme",
  "access-otp": "yes",
  "mcp-client": "not-now",
  renovate: "not-now",
};

/** The 11 scenarios of the CI setup matrix. */
export const SCENARIOS: Record<string, Scenario> = {
  "mcp github": { parts: "mcp", "sign-in": "github" },
  "mcp bearer": { parts: "mcp", "sign-in": "bearer" },
  "mcp access": { parts: "mcp", "sign-in": "access" },
  "web public": { parts: "web", "web-access": "public" },
  "web private": { parts: "web", "web-access": "private" },
  "both github public": { parts: "mcp,web", "sign-in": "github", "web-access": "public" },
  "both github private": {
    parts: "mcp,web",
    "sign-in": "github",
    "web-access": "private",
    hostname: "tools.example.com",
  },
  "both bearer public": { parts: "mcp,web", "sign-in": "bearer", "web-access": "public" },
  "both bearer private": {
    parts: "mcp,web",
    "sign-in": "bearer",
    "web-access": "private",
    hostname: "tools.example.com",
  },
  "both access public": { parts: "mcp,web", "sign-in": "access", "web-access": "public" },
  "both access private": { parts: "mcp,web", "sign-in": "access", "web-access": "private" },
};

const WORLDS = new WeakMap<Context, WorldOptions>();

/** A context like a fresh clone of a new project, before any login. */
export function freshContext(options: WorldOptions = {}): Context {
  const ctx: Context = {
    answers: {},
    local: { answers: {}, secretHashes: {} },
    repo: {
      root: "/work/acme-tools",
      origin: { owner: "octocat", name: "acme-tools" },
      wranglerVersion: "4.158.0",
      agentsBlock: false,
      renameLeftovers: ["package.json"],
      tree: { parts: ["mcp", "web"], signIn: "github", pristine: true },
      installed: false,
      configuredHost: null,
      configPending: ["wrangler.jsonc"],
      devVars: {},
      secretSources: { production: null, preview: null, apiToken: null },
      verified: false,
      clean: true,
      apiTokenFile: "/home/octocat/.config/setup-octocat-acme-tools/cloudflare-api-token",
    },
    facts: {
      ...structuredClone(EMPTY_FACTS),
      zones: [{ id: "z1", name: "example.com" }],
    },
    fixture: false,
  };
  WORLDS.set(ctx, options);
  return ctx;
}

function worldOf(ctx: Context): WorldOptions {
  return WORLDS.get(ctx) ?? {};
}

const LOCAL_KEYS = new Set(["who-may-sign-in", "mcp-client", "renovate"]);

/** Records an answer the way `answer` does, with the tree changes that a new answer causes. */
export function recordAnswer(ctx: Context, key: AnswerKey, value: string): void {
  if (LOCAL_KEYS.has(key)) {
    ctx.local.answers[key] = value;
  } else {
    // A committed answer changes `setup.json`, so the tree is dirty and unverified again, and
    // the config step may have something to write.
    ctx.repo.clean = false;
    ctx.repo.verified = false;
    ctx.repo.configPending = ["wrangler.jsonc"];
    ctx.facts.pushed = false;
    ctx.facts.deploy = null;
    ctx.facts.live = null;
  }
  ctx.answers[key] = value;
}

function hash(...values: string[]): string {
  return `hash:${values.join("|")}`;
}

// Changing tracked files makes the tree dirty and unverified.
function touchTree(ctx: Context): void {
  ctx.repo.clean = false;
  ctx.repo.verified = false;
}

/** Does what the person would do for a task. */
export function doTask(ctx: Context, id: string, scenario: Scenario): void {
  const world = worldOf(ctx);
  const { facts, repo } = ctx;
  switch (id) {
    case "login-github":
      facts.github = { login: "octocat" };
      break;
    case "login-wrangler":
      facts.wrangler = {
        accounts:
          world.accounts === 2
            ? [
                { id: ACCOUNT_A, name: "Acme" },
                { id: ACCOUNT_B, name: "Other" },
              ]
            : [{ id: ACCOUNT_A, name: "Acme" }],
      };
      facts.workersSubdomain = world.subdomain === false ? null : "acme";
      facts.repository = { description: "" };
      break;
    case "login-cf":
      facts.cf = { accountIds: [ACCOUNT_A, ACCOUNT_B] };
      facts.accessOrganization =
        world.zeroTrust === "none"
          ? null
          : {
              teamDomain: "acme.cloudflareaccess.com",
              onlyCloudflareLogin: world.zeroTrust === "cloudflare-only",
              hasOneTimePin: world.zeroTrust !== "cloudflare-only",
            };
      break;
    case "zero-trust-org":
      facts.accessOrganization = {
        teamDomain: "acme.cloudflareaccess.com",
        onlyCloudflareLogin: true,
        hasOneTimePin: false,
      };
      break;
    case "github-oauth-app":
      repo.devVars.GITHUB_CLIENT_ID = true;
      repo.devVars.GITHUB_CLIENT_SECRET = true;
      repo.secretSources.production = hash("client", "secret");
      facts.githubOAuth.production = true;
      break;
    case "github-oauth-app-previews":
      repo.devVars.PREVIEW_GITHUB_CLIENT_ID = true;
      repo.devVars.PREVIEW_GITHUB_CLIENT_SECRET = true;
      repo.secretSources.preview = hash("preview-client", "preview-secret");
      facts.githubOAuth.preview = true;
      break;
    case "cloudflare-api-token":
      facts.apiToken = { saved: true, valid: true };
      repo.secretSources.apiToken = hash("token");
      break;
    case "mcp-client":
    case "renovate":
      recordAnswer(ctx, id, scenario[id] ?? "not-now");
      break;
    default:
      throw new Error(`The pretend person can't do the task ${id}.`);
  }
}

/** Does what a step would do. */
export function doStep(ctx: Context, id: string): void {
  const { facts, repo, local, answers } = ctx;
  switch (id) {
    case "summary":
      local.summaryShown = true;
      break;
    case "agents-block":
      repo.agentsBlock = true;
      touchTree(ctx);
      break;
    case "rename":
      repo.renameLeftovers = [];
      touchTree(ctx);
      break;
    case "prune": {
      const parts = (answers.parts ?? "")
        .split(",")
        .filter((part): part is Part => part === "mcp" || part === "web");
      const signIn = signInOf(answers) ?? null;
      repo.tree = { parts, signIn, pristine: parts.length === 2 && signIn === "github" };
      touchTree(ctx);
      break;
    }
    case "install":
      repo.installed = true;
      touchTree(ctx);
      break;
    case "workers-subdomain":
      facts.workersSubdomain = answers["workers-subdomain"] ?? "acme";
      break;
    case "kv-namespaces":
      facts.kvNamespaces = { production: "kv-production", preview: "kv-preview" };
      break;
    case "access-otp":
      if (facts.accessOrganization !== null) {
        facts.accessOrganization.hasOneTimePin = true;
      }
      break;
    case "access-apps": {
      const desired = desiredAccessApps(ctx);
      if (desired !== null) {
        facts.accessApps = {
          allow: { ...desired.allow, aud: "aud-allow" },
          bypass: desired.bypass === null ? null : { ...desired.bypass, aud: "aud-bypass" },
        };
      }
      break;
    }
    case "config":
      repo.configPending = [];
      if (answers.hostname !== "workers.dev" || answers["sign-in"] === "github") {
        repo.configuredHost = answers.hostname ?? null;
      }
      touchTree(ctx);
      break;
    case "dev-vars":
      for (const key of ["COOKIE_SECRET", "MCP_BEARER_TOKEN"]) {
        repo.devVars[key] = true;
      }
      if (answers["sign-in"] === "bearer") {
        repo.secretSources.production = hash("bearer");
        repo.secretSources.preview = hash("bearer");
      }
      break;
    case "verify":
      repo.verified = true;
      break;
    case "commit":
      repo.clean = true;
      break;
    case "worker-secrets":
      facts.workerSecrets = workerSecretNames(answers);
      local.secretHashes.production = repo.secretSources.production ?? "";
      break;
    case "preview-secrets":
      facts.previewSecrets = previewSecretNames(answers);
      local.secretHashes.preview = repo.secretSources.preview ?? "";
      break;
    case "github-secrets":
      facts.githubSecrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
      local.secretHashes.apiToken = repo.secretSources.apiToken ?? "";
      break;
    case "github-variables": {
      const host =
        answers.hostname === "workers.dev"
          ? `acme-tools.${facts.workersSubdomain ?? ""}.workers.dev`
          : (answers.hostname ?? "");
      facts.githubVariables = { DEPLOY_ENABLED: "true", HEALTHCHECK_URL: `https://${host}` };
      break;
    }
    case "repository-description":
      facts.repository = { description: answers.description ?? "" };
      break;
    case "push":
      facts.pushed = true;
      facts.deploy = {
        url: "https://github.com/octocat/acme-tools/actions/runs/1",
        status: "pending",
        attempts: 1,
      };
      break;
    case "deploy-rerun":
      facts.deploy = {
        url: "https://github.com/octocat/acme-tools/actions/runs/1",
        status: "success",
        attempts: 2,
      };
      break;
    case "live-checks":
      facts.live = [{ name: "healthz", ok: true, detail: '200 {"ok":true}' }];
      break;
    default:
      throw new Error(`The pretend world has no step ${id}.`);
  }
}

/** The result of walking a whole run. */
export type Walk = { ctx: Context; actions: Action[]; asked: string[] };

/**
 * Runs the planner until it returns done, answering from the scenario and doing every task and
 * step. `check` runs before each action, so tests can assert invariants at every point.
 */
export function walk(
  scenario: Scenario,
  options: WorldOptions = {},
  check: (ctx: Context, action: Action) => void = () => undefined,
): Walk {
  const answers = { ...SHARED_ANSWERS, ...scenario };
  const ctx = freshContext(options);
  const actions: Action[] = [];
  const asked: string[] = [];
  for (let turn = 0; turn < 200; turn++) {
    const action = plan(ctx);
    check(ctx, action);
    actions.push(action);
    switch (action.kind) {
      case "done":
        return { ctx, actions, asked };
      case "question": {
        const value = answers[action.key];
        if (value === undefined) {
          throw new Error(`The scenario has no answer for ${action.key}.`);
        }
        if (asked.includes(action.key)) {
          throw new Error(`The planner asked ${action.key} twice.`);
        }
        asked.push(action.key);
        recordAnswer(ctx, action.key, value);
        break;
      }
      case "task":
        doTask(ctx, action.id, answers);
        break;
      case "step":
        doStep(ctx, action.id);
        break;
      case "wait":
        if (ctx.facts.deploy !== null) {
          ctx.facts.deploy.status = "success";
        }
        ctx.facts.live = [{ name: "healthz", ok: true, detail: "200" }];
        break;
    }
  }
  throw new Error("The planner didn't reach done in 200 turns.");
}
