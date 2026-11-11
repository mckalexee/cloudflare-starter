// The steps that change GitHub and Cloudflare. Each one prints its command before it runs, reads
// secret values from `.dev.vars` or the token file, and sends them only on standard input or in a
// temporary file outside the repository. Each is idempotent: it creates what's missing, updates
// what differs, and records the hash of every secret it uploads, so a changed value uploads again.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import {
  accountId,
  desiredAccessApps,
  host,
  previewSecretNames,
  workerSecretNames,
  workersSubdomain,
  type DesiredAccessApp,
} from "./derive.ts";
import { run, say, StepError, withSecretFile } from "./exec.ts";
import {
  accountEnv,
  cfCommand,
  cloudflareApi,
  DEPLOY_JOB,
  readApiToken,
  repoSlug,
  wranglerCommand,
} from "./remote.ts";
import { readDevVars, updateLocal } from "./state.ts";
import type { AccessAppFact, Context, SecretTarget } from "./types.ts";

function requireAccount(ctx: Context): string {
  const id = accountId(ctx);
  if (id === undefined) {
    throw new StepError("No Cloudflare account is chosen yet.");
  }
  return id;
}

function wrangler(
  ctx: Context,
  args: string[],
  options: { cwd?: string; display?: string } = {},
): void {
  const [command, ...prefix] = wranglerCommand(ctx);
  run(options.cwd ?? ctx.repo.root, command, [...prefix, ...args], {
    env: accountEnv(ctx),
    display: `wrangler ${options.display ?? args.join(" ")}`,
  });
}

function cf(ctx: Context, args: string[], display: string): string {
  const command = cfCommand(ctx);
  if (command === undefined) {
    throw new StepError("The Cloudflare CLI isn't installed. Run `pnpm install` first.");
  }
  return run(ctx.repo.root, command, args, {
    env: accountEnv(ctx),
    capture: true,
    display: `cf ${display}`,
  });
}

function recordHash(ctx: Context, target: SecretTarget): void {
  const hash = ctx.repo.secretSources[target];
  updateLocal(ctx.repo.root, (state) => {
    if (hash === null) {
      delete state.secretHashes[target];
    } else {
      state.secretHashes[target] = hash;
    }
  });
}

function devVar(ctx: Context, key: string): string {
  const value = readDevVars(ctx.repo.root).get(key) ?? "";
  if (value === "") {
    throw new StepError(`.dev.vars has no value for ${key}.`);
  }
  return value;
}

function cookieSecret(): string {
  return randomBytes(32).toString("hex");
}

/** The JSON body of an Access application, in the shape that `docs/auth.md` shows. */
export function accessAppPayload(app: DesiredAccessApp): Record<string, unknown> {
  const bypass = app.include.includes("everyone");
  const include = app.include.map((rule) => {
    if (rule === "everyone") {
      return { everyone: {} };
    }
    const [kind, value] = rule.split(/:(.*)/s);
    return kind === "email" ? { email: { email: value } } : { email_domain: { domain: value } };
  });
  return {
    type: "self_hosted",
    name: app.name,
    domain: app.domain,
    destinations: app.destinations.map((uri) => ({ type: "public", uri })),
    ...(bypass ? {} : { session_duration: "24h" }),
    ...(app.managedOAuth
      ? {
          oauth_configuration: {
            enabled: true,
            dynamic_client_registration: {
              enabled: true,
              allow_any_on_localhost: true,
              allow_any_on_loopback: true,
              allowed_uris: [
                "https://claude.ai/api/mcp/auth_callback",
                "https://claude.com/api/mcp/auth_callback",
              ],
            },
            grant: { access_token_lifetime: "15m", session_duration: "24h" },
          },
        }
      : {}),
    policies: [
      bypass
        ? { name: "Public paths", decision: "bypass", include }
        : { name: "Allowed people", decision: "allow", include },
    ],
  };
}

function applyAccessApp(ctx: Context, app: DesiredAccessApp, existing: AccessAppFact | null): void {
  const body = JSON.stringify(accessAppPayload(app));
  const what = `<payload for ${app.name} on ${app.domain}>`;
  if (existing === null) {
    cf(
      ctx,
      ["zero-trust", "access", "applications", "create", "--body", body],
      `zero-trust access applications create --body ${what}`,
    );
  } else {
    cf(
      ctx,
      ["zero-trust", "access", "applications", "update", existing.id, "--body", body],
      `zero-trust access applications update ${existing.id} --body ${what}`,
    );
  }
}

function gh(ctx: Context, args: string[], stdin?: string): void {
  run(ctx.repo.root, "gh", args, { stdin });
}

/** The remote steps by ID. */
export const REMOTE_STEPS = {
  "workers-subdomain": (ctx: Context) => {
    const id = requireAccount(ctx);
    const subdomain = workersSubdomain(ctx) ?? "";
    say(
      `$ PUT /accounts/${id}/workers/subdomain {"subdomain":"${subdomain}"}, with Wrangler's login`,
    );
    const response = cloudflareApi(ctx, "PUT", `/accounts/${id}/workers/subdomain`, { subdomain });
    if (!response.success) {
      throw new StepError(
        `Cloudflare refused the subdomain ${subdomain}: ${response.errors} Choose another with \`node scripts/setup.ts answer workers-subdomain <name>\`.`,
      );
    }
  },
  "kv-namespaces": (ctx: Context) => {
    requireAccount(ctx);
    const { name } = ctx.repo.origin;
    const { production, preview } = ctx.facts.kvNamespaces;
    // Outside the project folder, Wrangler doesn't offer to edit `wrangler.jsonc`. The config
    // step writes the IDs.
    if (production === null) {
      wrangler(ctx, ["kv", "namespace", "create", `${name}-kv`], { cwd: tmpdir() });
    }
    if (preview === null) {
      wrangler(ctx, ["kv", "namespace", "create", `${name}-kv-preview`], { cwd: tmpdir() });
    }
  },
  "access-otp": (ctx: Context) => {
    const body = JSON.stringify({ name: "One-time PIN", type: "onetimepin", config: {} });
    cf(
      ctx,
      ["zero-trust", "identity-providers", "create", "--body", body],
      `zero-trust identity-providers create --body '${body}'`,
    );
  },
  "access-apps": (ctx: Context) => {
    const desired = desiredAccessApps(ctx);
    if (desired === null) {
      throw new StepError(
        "The hostname isn't settled, so the Access applications can't be created.",
      );
    }
    // The bypass application comes first, so its paths are never blocked.
    if (desired.bypass !== null) {
      applyAccessApp(ctx, desired.bypass, ctx.facts.accessApps.bypass);
    }
    applyAccessApp(ctx, desired.allow, ctx.facts.accessApps.allow);
  },
  "worker-secrets": (ctx: Context) => {
    const names = workerSecretNames(ctx.answers);
    const values: Record<string, string> = names.includes("MCP_BEARER_TOKEN")
      ? { MCP_BEARER_TOKEN: devVar(ctx, "MCP_BEARER_TOKEN") }
      : {
          GITHUB_CLIENT_ID: devVar(ctx, "GITHUB_CLIENT_ID"),
          GITHUB_CLIENT_SECRET: devVar(ctx, "GITHUB_CLIENT_SECRET"),
          // Production gets its own cookie secret, never the local one.
          COOKIE_SECRET: cookieSecret(),
        };
    withSecretFile("secrets.json", JSON.stringify(values), (file) => {
      wrangler(ctx, ["secret", "bulk", file, "--name", ctx.repo.origin.name], {
        display: `secret bulk <temporary file with ${names.join(", ")}> --name ${ctx.repo.origin.name}`,
      });
    });
    recordHash(ctx, "production");
  },
  "preview-secrets": (ctx: Context) => {
    const names = previewSecretNames(ctx.answers);
    const values: Record<string, string> = names.includes("MCP_BEARER_TOKEN")
      ? { MCP_BEARER_TOKEN: devVar(ctx, "MCP_BEARER_TOKEN") }
      : {
          GITHUB_CLIENT_ID: devVar(ctx, "PREVIEW_GITHUB_CLIENT_ID"),
          GITHUB_CLIENT_SECRET: devVar(ctx, "PREVIEW_GITHUB_CLIENT_SECRET"),
          COOKIE_SECRET: cookieSecret(),
        };
    withSecretFile("secrets.json", JSON.stringify(values), (file) => {
      wrangler(
        ctx,
        ["preview", "base-config", "secret", "bulk", file, "--worker-name", ctx.repo.origin.name],
        {
          display: `preview base-config secret bulk <temporary file with ${names.join(", ")}> --worker-name ${ctx.repo.origin.name}`,
        },
      );
    });
    recordHash(ctx, "preview");
  },
  "github-secrets": (ctx: Context) => {
    const id = requireAccount(ctx);
    const token = readApiToken(ctx.repo.apiTokenFile);
    if (token === undefined) {
      throw new StepError(`The token file ${ctx.repo.apiTokenFile} is missing or empty.`);
    }
    // The token travels on standard input, so it never appears in the arguments.
    gh(ctx, ["secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", repoSlug(ctx)], token);
    gh(ctx, ["secret", "set", "CLOUDFLARE_ACCOUNT_ID", "--repo", repoSlug(ctx), "--body", id]);
    recordHash(ctx, "apiToken");
  },
  "github-variables": (ctx: Context) => {
    gh(ctx, ["variable", "set", "DEPLOY_ENABLED", "--repo", repoSlug(ctx), "--body", "true"]);
    gh(ctx, [
      "variable",
      "set",
      "HEALTHCHECK_URL",
      "--repo",
      repoSlug(ctx),
      "--body",
      `https://${host(ctx) ?? ""}`,
    ]);
  },
  "repository-description": (ctx: Context) => {
    gh(ctx, ["repo", "edit", repoSlug(ctx), "--description", ctx.answers.description ?? ""]);
  },
  push: (ctx: Context) => {
    run(ctx.repo.root, "git", ["push", "origin", "HEAD:main"]);
  },
  "deploy-rerun": (ctx: Context) => {
    const deploy = ctx.facts.deploy;
    if (deploy === null) {
      throw new StepError("There's no deploy run to rerun.");
    }
    gh(ctx, ["run", "rerun", String(deploy.runId), "--failed", "--repo", repoSlug(ctx)]);
  },
  "deploy-failed": (ctx: Context) => {
    const deploy = ctx.facts.deploy;
    if (deploy === null) {
      throw new StepError("There's no deploy run.");
    }
    if (deploy.conclusion === "skipped") {
      throw new StepError(
        `The ${DEPLOY_JOB} job of ${deploy.url} was skipped twice, which happens when the repository variable DEPLOY_ENABLED isn't true. Check it with \`gh variable list\`.`,
      );
    }
    try {
      run(ctx.repo.root, "gh", [
        "run",
        "view",
        String(deploy.runId),
        "--log-failed",
        "--repo",
        repoSlug(ctx),
      ]);
    } catch {
      // The log is a courtesy. The failure below is the result.
    }
    throw new StepError(
      `The ${DEPLOY_JOB} job of ${deploy.url} failed after one rerun. Its log is in this step. Fix the cause, commit, and run the script again.`,
    );
  },
  "live-checks": (ctx: Context) => {
    const failed = (ctx.facts.live ?? []).filter((check) => !check.ok);
    for (const check of failed) {
      say(`- ${check.name}: ${check.detail}`);
    }
    throw new StepError(
      `The deployed Worker failed ${String(failed.length)} live check${failed.length === 1 ? "" : "s"}, listed in this step. A custom domain can take a few minutes after the first deploy, so run the script again shortly. If a check keeps failing, compare the Access applications and the vars with the answers.`,
    );
  },
};
