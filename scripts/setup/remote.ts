// The remote probes: what the script reads from GitHub, Cloudflare, and the deployed Worker on
// every run outside fixture mode. Each probe is synchronous and runs only when the planner reads
// its fact, so an early run doesn't pay for the deploy checks. GitHub calls go through `gh`.
// Cloudflare calls go through Wrangler, the Cloudflare API with Wrangler's login, or `cf` for
// Access, because only `cf`'s login carries the Access scopes. No probe prints a secret.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { accessUsed, accountId, hasWeb, host, signIn, webPrivate } from "./derive.ts";
import { ProbeError, tools, type ExecResult } from "./exec.ts";
import { readDevVars, updateLocal } from "./state.ts";
import type { AccessAppFact, Context, DeployFact, LiveCheck, RemoteFacts } from "./types.ts";

/** The name of the deploy job in `.github/workflows/deploy.yml`. */
export const DEPLOY_JOB = "Deploy to production";

/** The scopes that the Cloudflare CLI login needs. */
export const CF_SCOPES = "account:read user:read access:read access:write offline";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

function binary(root: string, name: string): string | undefined {
  const file = path.join(root, "node_modules", ".bin", name);
  return existsSync(file) ? file : undefined;
}

/**
 * The command that runs Wrangler: the project's own copy after the install, or the pinned version
 * through `npx` before it.
 */
export function wranglerCommand(ctx: Context): [string, ...string[]] {
  const local = binary(ctx.repo.root, "wrangler");
  return local === undefined ? ["npx", "--yes", `wrangler@${ctx.repo.wranglerVersion}`] : [local];
}

/** The project's Cloudflare CLI, which exists only after the install. */
export function cfCommand(ctx: Context): string | undefined {
  return binary(ctx.repo.root, "cf");
}

/** The environment that pins Wrangler and `cf` to the chosen account. */
export function accountEnv(ctx: Context): Record<string, string> {
  const id = accountId(ctx);
  return id === undefined ? {} : { CLOUDFLARE_ACCOUNT_ID: id };
}

/** Parses the JSON in a command's output, skipping a banner that some commands print first. */
export function parseJson(text: string): unknown {
  // Wrangler prints notices first, such as "Using redirected Wrangler configuration.", and a
  // notice can hold a bracket, such as "[WARNING]". So the JSON starts at the first line that
  // begins with a brace or a bracket and parses through to the end.
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trimStart() ?? "";
    if (!line.startsWith("{") && !line.startsWith("[")) {
      continue;
    }
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      // A notice that only starts like JSON. Try the next line.
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function exec(
  ctx: Context,
  command: string,
  args: string[],
  env: Record<string, string> = {},
): ExecResult {
  return tools().exec(command, args, { cwd: ctx.repo.root, env });
}

// `account: false` is for the calls that find the accounts, which can't depend on the answer.
function wrangler(ctx: Context, args: string[], account = true): ExecResult {
  const [command, ...prefix] = wranglerCommand(ctx);
  // Outside the project folder, Wrangler doesn't read `wrangler.jsonc`, which may still hold the
  // template's placeholders.
  return tools().exec(command, [...prefix, ...args], {
    cwd: tmpdir(),
    env: account ? accountEnv(ctx) : {},
  });
}

function cf(ctx: Context, args: string[]): ExecResult | undefined {
  const command = cfCommand(ctx);
  return command === undefined ? undefined : exec(ctx, command, args, accountEnv(ctx));
}

function gh(ctx: Context, args: string[]): ExecResult {
  return exec(ctx, "gh", args);
}

/** The `owner/name` of the project's repository. */
export function repoSlug(ctx: Context): string {
  return `${ctx.repo.origin.owner}/${ctx.repo.origin.name}`;
}

const tokens = new Map<string, string | null>();

/** Wrangler's OAuth token, for Cloudflare API calls that Wrangler has no command for. */
export function cloudflareToken(ctx: Context): string | undefined {
  if (!tokens.has(ctx.repo.root)) {
    const result = wrangler(ctx, ["auth", "token", "--json"], false);
    const parsed = result.status === 0 ? parseJson(result.stdout) : undefined;
    tokens.set(ctx.repo.root, isRecord(parsed) ? (str(parsed.token) ?? null) : null);
  }
  return tokens.get(ctx.repo.root) ?? undefined;
}

/** The parts of a Cloudflare API response that the script reads. */
export type ApiResult = { status: number; success: boolean; result: unknown; errors: string };

/** Calls the Cloudflare API with Wrangler's login, or with `token` when one is given. */
export function cloudflareApi(
  ctx: Context,
  method: string,
  route: string,
  body?: unknown,
  token = cloudflareToken(ctx),
): ApiResult {
  if (token === undefined) {
    return { status: 0, success: false, result: null, errors: "Wrangler isn't signed in." };
  }
  const response = tools().http({
    method,
    url: `${CLOUDFLARE_API}${route}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = parseJson(response.body);
  const record = isRecord(parsed) ? parsed : {};
  const errors = Array.isArray(record.errors)
    ? record.errors.map((error) => (isRecord(error) ? str(error.message) : "")).join(" ")
    : response.body.slice(0, 200);
  return {
    status: response.status,
    success: record.success === true,
    result: record.result,
    errors,
  };
}

/** A short hash of secret values, for caches and upload tracking. */
export function hashValues(values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

// Remembers a passed check of a secret value by its hash, so the script doesn't ask GitHub or
// Cloudflare again on every run. A changed value has a new hash and gets checked again.
function cachedCheck(ctx: Context, values: string[], check: () => boolean): boolean {
  const hash = hashValues(values);
  const passed = (ctx.local.validated ?? "").split(",");
  if (passed.includes(hash)) {
    return true;
  }
  const ok = check();
  if (ok) {
    updateLocal(ctx.repo.root, (state) => {
      state.validated = [...(state.validated ?? "").split(","), hash].filter(Boolean).join(",");
    });
  }
  return ok;
}

/**
 * Whether GitHub accepts an OAuth app's client ID and secret. The token endpoint answers an
 * unknown code with `bad_verification_code` when the pair is right, and with
 * `incorrect_client_credentials` or "Not Found" when it isn't. GitHub documents both errors under
 * "Troubleshooting OAuth app access token request errors". No sign-in is needed.
 */
export function githubPairAccepted(clientId: string, clientSecret: string): boolean {
  const response = tools().http({
    method: "POST",
    url: "https://github.com/login/oauth/access_token",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: "setup-check",
    }).toString(),
  });
  const parsed = parseJson(response.body);
  return isRecord(parsed) && parsed.error === "bad_verification_code";
}

function oauthPair(ctx: Context, idKey: string, secretKey: string): boolean | null {
  const values = readDevVars(ctx.repo.root);
  const id = values.get(idKey) ?? "";
  const secret = values.get(secretKey) ?? "";
  if (id === "" || secret === "") {
    return null;
  }
  return cachedCheck(ctx, [id, secret], () => githubPairAccepted(id, secret));
}

/** Reads the API token for GitHub Actions from its file, or `undefined` when it's missing. */
export function readApiToken(file: string): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  const token = readFileSync(file, "utf8").trim();
  return token === "" ? undefined : token;
}

function names(value: unknown): string[] {
  const list = isRecord(value) && Array.isArray(value.result) ? value.result : value;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }
    return isRecord(item) && typeof item.name === "string" ? [item.name] : [];
  });
}

function includeRule(rule: unknown): string[] {
  if (!isRecord(rule)) {
    return [];
  }
  if (isRecord(rule.email) && typeof rule.email.email === "string") {
    return [`email:${rule.email.email.toLowerCase()}`];
  }
  if (isRecord(rule.email_domain) && typeof rule.email_domain.domain === "string") {
    return [`domain:${rule.email_domain.domain.toLowerCase()}`];
  }
  return "everyone" in rule ? ["everyone"] : [];
}

/** Turns an Access application from the API into the fact that the planner compares. */
export function accessAppFact(app: Record<string, unknown>): AccessAppFact {
  const destinations = Array.isArray(app.destinations)
    ? app.destinations.flatMap((destination) =>
        isRecord(destination) && typeof destination.uri === "string" ? [destination.uri] : [],
      )
    : [];
  const policies = Array.isArray(app.policies) ? app.policies : [];
  const include = policies.flatMap((policy) =>
    isRecord(policy) && Array.isArray(policy.include) ? policy.include.flatMap(includeRule) : [],
  );
  return {
    id: str(app.id) ?? "",
    aud: str(app.aud) ?? "",
    domain: str(app.domain) ?? "",
    destinations,
    include: [...new Set(include)].toSorted(),
    managedOAuth: isRecord(app.oauth_configuration) && app.oauth_configuration.enabled === true,
  };
}

/** The names of the project's Access applications. */
export function accessAppNames(name: string): { allow: string; bypass: string[] } {
  return { allow: name, bypass: [`${name} health check`, `${name} public paths`] };
}

function headSha(ctx: Context): string | undefined {
  const result = exec(ctx, "git", ["rev-parse", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Reads the deploy run for a commit, judged by the deploy job, never by the run. */
export function readDeploy(ctx: Context, sha: string): DeployFact | null {
  const runs = parseJson(
    gh(ctx, [
      "api",
      `repos/${repoSlug(ctx)}/actions/workflows/deploy.yml/runs?head_sha=${sha}&event=push&per_page=1`,
    ]).stdout,
  );
  const run =
    isRecord(runs) && Array.isArray(runs.workflow_runs) ? runs.workflow_runs[0] : undefined;
  if (!isRecord(run) || typeof run.id !== "number") {
    return null;
  }
  const url = str(run.html_url) ?? "";
  const attempts = typeof run.run_attempt === "number" ? run.run_attempt : 1;
  const base = { url, attempts, runId: run.id };
  if (run.status !== "completed") {
    return { ...base, status: "pending" };
  }
  const jobs = parseJson(
    gh(ctx, ["api", `repos/${repoSlug(ctx)}/actions/runs/${String(run.id)}/jobs`]).stdout,
  );
  const job =
    isRecord(jobs) && Array.isArray(jobs.jobs)
      ? jobs.jobs.find((candidate) => isRecord(candidate) && candidate.name === DEPLOY_JOB)
      : undefined;
  if (!isRecord(job) || job.status !== "completed") {
    return { ...base, status: job === undefined ? "failure" : "pending", conclusion: "missing" };
  }
  // A skipped job leaves the run's conclusion `success`, so only the job's own conclusion counts.
  const conclusion = str(job.conclusion) ?? "unknown";
  return { ...base, status: conclusion === "success" ? "success" : "failure", conclusion };
}

function header(response: { headers: Record<string, string> }, name: string): string {
  return response.headers[name] ?? response.headers[name.toLowerCase()] ?? "";
}

const MCP_INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "setup-check", version: "1.0.0" },
  },
});

/**
 * The live checks against the deployed Worker. None of them follows a redirect, so an Access login
 * page never counts as the Worker's answer.
 */
export function liveChecks(ctx: Context): LiveCheck[] {
  const hostname = host(ctx) ?? "";
  const base = `https://${hostname}`;
  const http = tools().http;
  const checks: LiveCheck[] = [];
  const healthz = http({ url: `${base}/healthz` });
  checks.push(
    liveCheck(
      "healthz",
      healthz.status === 200 && healthz.body.trim() === '{"ok":true}',
      `GET /healthz answered ${String(healthz.status)} ${healthz.body.trim().slice(0, 80)}`,
      '200 with {"ok":true}',
    ),
  );
  const mode = signIn(ctx.answers);
  if (mode !== undefined) {
    const challenge = http({
      method: "POST",
      url: `${base}/mcp`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    const authenticate = header(challenge, "www-authenticate");
    const expected =
      mode === "github"
        ? `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
        : mode === "access"
          ? "cloudflare-access-protected-resource"
          : "Bearer";
    checks.push(
      liveCheck(
        "sign-in challenge",
        challenge.status === 401 && authenticate.includes(expected),
        `POST /mcp without a token answered ${String(challenge.status)} with WWW-Authenticate: ${authenticate.slice(0, 160) || "none"}`,
        `401 with ${expected} in WWW-Authenticate, the challenge of ${mode === "github" ? "GitHub OAuth" : mode === "access" ? "Cloudflare Access" : "bearer mode"}`,
      ),
    );
    if (mode === "bearer") {
      const token = readDevVars(ctx.repo.root).get("MCP_BEARER_TOKEN") ?? "";
      const call = http({
        method: "POST",
        url: `${base}/mcp`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: MCP_INITIALIZE,
      });
      checks.push(
        liveCheck(
          "authenticated MCP call",
          call.status === 200 && call.body.includes('"serverInfo"'),
          `POST /mcp with the token from .dev.vars answered ${String(call.status)}`,
          "200 with the server info",
        ),
      );
    }
  }
  if (hasWeb(ctx.answers) && webPrivate(ctx.answers)) {
    const page = http({ url: `${base}/`, headers: { accept: "text/html" } });
    const location = header(page, "location");
    checks.push(
      liveCheck(
        "web app behind Access",
        page.status === 302 && location.includes("/cdn-cgi/access/login/"),
        `GET / answered ${String(page.status)}${location === "" ? "" : ` with a redirect to ${location.split("?")[0] ?? ""}`}`,
        "a redirect to the Access login",
      ),
    );
  }
  return checks;
}

// A live check whose detail says what the script saw, and then either that it matched or what it
// expected instead. Only a failure names the expectation.
function liveCheck(name: string, ok: boolean, seen: string, expected: string): LiveCheck {
  return {
    name,
    ok,
    detail: ok ? `${seen}, which matches ${expected}.` : `${seen}. Expected ${expected}.`,
  };
}

/** The real remote probes, one per field of `RemoteFacts`. */
export const REAL_PROBES: { [K in keyof RemoteFacts]: (ctx: Context) => RemoteFacts[K] } = {
  github: (ctx) => {
    if (gh(ctx, ["auth", "status"]).status !== 0) {
      return null;
    }
    const login = gh(ctx, ["api", "user", "--jq", ".login"]);
    return login.status === 0 ? { login: login.stdout.trim() } : null;
  },
  wrangler: (ctx) => {
    const parsed = parseJson(wrangler(ctx, ["whoami", "--json"], false).stdout);
    if (!isRecord(parsed) || parsed.loggedIn !== true || !Array.isArray(parsed.accounts)) {
      return null;
    }
    const email = str(parsed.email);
    return {
      accounts: parsed.accounts.flatMap((account) =>
        isRecord(account) && typeof account.id === "string"
          ? [{ id: account.id, name: str(account.name) ?? account.id }]
          : [],
      ),
      ...(email === undefined ? {} : { email }),
    };
  },
  cf: (ctx) => {
    const result = cf(ctx, ["auth", "whoami"]);
    const parsed = result === undefined ? undefined : parseJson(result.stdout);
    if (!isRecord(parsed) || parsed.authenticated !== true || parsed.tokenValid !== true) {
      return null;
    }
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    const email = str(parsed.email);
    return {
      accountIds: accounts.flatMap((account) =>
        isRecord(account) && typeof account.id === "string" ? [account.id] : [],
      ),
      ...(email === undefined ? {} : { email }),
    };
  },
  repository: (ctx) => {
    if (ctx.facts.github === null) {
      return null;
    }
    const parsed = parseJson(
      gh(ctx, ["repo", "view", repoSlug(ctx), "--json", "description"]).stdout,
    );
    return isRecord(parsed) ? { description: str(parsed.description) ?? "" } : null;
  },
  workersSubdomain: (ctx) => {
    const id = accountId(ctx);
    if (id === undefined || ctx.facts.wrangler === null) {
      return null;
    }
    const response = cloudflareApi(ctx, "GET", `/accounts/${id}/workers/subdomain`);
    return isRecord(response.result) ? (str(response.result.subdomain) ?? null) : null;
  },
  zones: (ctx) => {
    const id = accountId(ctx);
    if (id === undefined || ctx.facts.wrangler === null) {
      return [];
    }
    const response = cloudflareApi(ctx, "GET", `/zones?account.id=${id}&per_page=50`);
    return Array.isArray(response.result)
      ? response.result.flatMap((zone) =>
          isRecord(zone) && typeof zone.id === "string" && typeof zone.name === "string"
            ? [{ id: zone.id, name: zone.name }]
            : [],
        )
      : [];
  },
  accessOrganization: (ctx) => {
    if (!accessUsed(ctx.answers) || ctx.facts.cf === null || accountId(ctx) === undefined) {
      return null;
    }
    const org = cf(ctx, ["zero-trust", "organization", "get"]);
    const parsed = org === undefined || org.status !== 0 ? undefined : parseJson(org.stdout);
    const teamDomain = isRecord(parsed) ? str(parsed.auth_domain) : undefined;
    if (teamDomain === undefined) {
      return null;
    }
    const providers = parseJson(
      cf(ctx, ["zero-trust", "identity-providers", "list"])?.stdout ?? "",
    );
    const types = (Array.isArray(providers) ? providers : []).flatMap((provider) =>
      isRecord(provider) && typeof provider.type === "string" ? [provider.type] : [],
    );
    return {
      teamDomain,
      onlyCloudflareLogin: types.every((type) => type === "cloudflare"),
      hasOneTimePin: types.includes("onetimepin"),
    };
  },
  kvNamespaces: (ctx) => {
    const empty = { production: null, preview: null };
    if (ctx.facts.wrangler === null || accountId(ctx) === undefined) {
      return empty;
    }
    const parsed = parseJson(wrangler(ctx, ["kv", "namespace", "list"]).stdout);
    if (!Array.isArray(parsed)) {
      return empty;
    }
    const find = (title: string) => {
      const match = parsed.find((namespace) => isRecord(namespace) && namespace.title === title);
      return isRecord(match) ? (str(match.id) ?? null) : null;
    };
    const { name } = ctx.repo.origin;
    return { production: find(`${name}-kv`), preview: find(`${name}-kv-preview`) };
  },
  accessApps: (ctx) => {
    const empty = { allow: null, bypass: null };
    if (!accessUsed(ctx.answers) || ctx.facts.cf === null || accountId(ctx) === undefined) {
      return empty;
    }
    const wanted = accessAppNames(ctx.repo.origin.name);
    const allow = appsNamed(ctx, wanted.allow)[0];
    const bypass = wanted.bypass.flatMap((name) => appsNamed(ctx, name))[0];
    return {
      allow: allow === undefined ? null : accessAppFact(allow),
      bypass: bypass === undefined ? null : accessAppFact(bypass),
    };
  },
  githubOAuth: (ctx) => {
    if (signIn(ctx.answers) !== "github") {
      return { production: null, preview: null };
    }
    return {
      production: oauthPair(ctx, "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
      preview:
        ctx.answers["oauth-previews"] === "yes"
          ? oauthPair(ctx, "PREVIEW_GITHUB_CLIENT_ID", "PREVIEW_GITHUB_CLIENT_SECRET")
          : null,
    };
  },
  apiToken: (ctx) => {
    const token = readApiToken(ctx.repo.apiTokenFile);
    const id = accountId(ctx);
    if (token === undefined) {
      return { saved: false, valid: null };
    }
    if (id === undefined) {
      return { saved: true, valid: null };
    }
    const valid = cachedCheck(ctx, [id, token], () => {
      const response = cloudflareApi(ctx, "GET", `/accounts/${id}/tokens/verify`, undefined, token);
      return response.success && isRecord(response.result) && response.result.status === "active";
    });
    return { saved: true, valid };
  },
  workerSecrets: (ctx) => {
    if (ctx.facts.wrangler === null || accountId(ctx) === undefined) {
      return null;
    }
    const result = wrangler(ctx, [
      "secret",
      "list",
      "--name",
      ctx.repo.origin.name,
      "--format",
      "json",
    ]);
    return result.status === 0 ? names(parseJson(result.stdout)) : null;
  },
  previewSecrets: (ctx) => {
    if (ctx.facts.wrangler === null || accountId(ctx) === undefined) {
      return [];
    }
    const result = wrangler(ctx, [
      "preview",
      "base-config",
      "secret",
      "list",
      "--worker-name",
      ctx.repo.origin.name,
      "--json",
    ]);
    return result.status === 0 ? names(parseJson(result.stdout)) : [];
  },
  githubSecrets: (ctx) =>
    ctx.facts.github === null
      ? []
      : names(
          parseJson(gh(ctx, ["secret", "list", "--repo", repoSlug(ctx), "--json", "name"]).stdout),
        ),
  githubVariables: (ctx) => {
    if (ctx.facts.github === null) {
      return {};
    }
    const parsed = parseJson(
      gh(ctx, ["variable", "list", "--repo", repoSlug(ctx), "--json", "name,value"]).stdout,
    );
    return Object.fromEntries(
      (Array.isArray(parsed) ? parsed : []).flatMap((variable) =>
        isRecord(variable) && typeof variable.name === "string"
          ? [[variable.name, str(variable.value) ?? ""]]
          : [],
      ),
    );
  },
  pushed: (ctx) => {
    const head = headSha(ctx);
    const remote = exec(ctx, "git", ["ls-remote", "origin", "refs/heads/main"]);
    return head !== undefined && remote.status === 0 && remote.stdout.split(/\s/)[0] === head;
  },
  deploy: (ctx) => {
    const head = headSha(ctx);
    return !ctx.facts.pushed || head === undefined ? null : readDeploy(ctx, head);
  },
  live: (ctx) => (ctx.facts.deploy?.status === "success" ? liveChecks(ctx) : null),
  worker: (ctx) => {
    const id = accountId(ctx);
    if (id === undefined || ctx.facts.wrangler === null) {
      return null;
    }
    const response = cloudflareApi(
      ctx,
      "GET",
      `/accounts/${id}/workers/services/${ctx.repo.origin.name}`,
    );
    if (response.status === 404) {
      return null;
    }
    const environment = isRecord(response.result) ? response.result.default_environment : undefined;
    const tag = isRecord(environment) ? str(environment.script_tag) : undefined;
    if (!response.success || tag === undefined) {
      throw new ProbeError(
        `Cloudflare didn't say whether the Worker ${ctx.repo.origin.name} exists: ${response.errors}`,
      );
    }
    return { tag };
  },
  repoDeployed: (ctx) => {
    if (ctx.facts.github === null) {
      return false;
    }
    const runs = parseJson(
      gh(ctx, [
        "api",
        `repos/${repoSlug(ctx)}/actions/workflows/deploy.yml/runs?status=success&per_page=10`,
      ]).stdout,
    );
    const ids =
      isRecord(runs) && Array.isArray(runs.workflow_runs)
        ? runs.workflow_runs.flatMap((run) =>
            isRecord(run) && typeof run.id === "number" ? [run.id] : [],
          )
        : [];
    return ids.some((runId) => {
      const jobs = parseJson(
        gh(ctx, ["api", `repos/${repoSlug(ctx)}/actions/runs/${String(runId)}/jobs`]).stdout,
      );
      return (
        isRecord(jobs) &&
        Array.isArray(jobs.jobs) &&
        jobs.jobs.some(
          (job) => isRecord(job) && job.name === DEPLOY_JOB && job.conclusion === "success",
        )
      );
    });
  },
};

// Lists the Access applications with exactly this name. A failed call stops the run, because a
// missed application could be created twice or overwritten.
function appsNamed(ctx: Context, name: string): Record<string, unknown>[] {
  const result = cf(ctx, [
    "zero-trust",
    "access",
    "applications",
    "list",
    "--name",
    name,
    "--exact",
  ]);
  const parsed = result === undefined || result.status !== 0 ? undefined : parseJson(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new ProbeError(
      `The Cloudflare CLI couldn't list the Access applications named ${name}: ${(result?.stderr ?? "it isn't installed").trim().slice(0, 300)}`,
    );
  }
  return parsed.filter(isRecord).filter((app) => app.name === name);
}
