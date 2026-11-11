// The probes that read the state of the run on every invocation. Local probes read the
// repository and always run for real. Remote probes read GitHub and Cloudflare, and
// `SETUP_FIXTURE=<file>` replaces all of them with the fixed facts in that file. `loadContext()`
// runs both and hands the planner one `Context`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { AGENTS_BLOCK_START, configuredHost, pendingConfig } from "./config.ts";
import { TEMPLATE_REPOSITORY } from "./derive.ts";
import { NotBuiltError, read } from "./exec.ts";
import { mergedAnswers, readLocal } from "./state.ts";
import type {
  Answers,
  Context,
  LocalState,
  Part,
  RemoteFacts,
  RepoFacts,
  SecretTarget,
  SignIn,
  TreeFacts,
} from "./types.ts";

/** Thrown when the script must not run at all, such as in the template repository. */
export class RefusalError extends Error {
  override readonly name = "RefusalError";
}

/** The facts before any probe found anything: no logins, no resources, no deploy. */
export const EMPTY_FACTS: RemoteFacts = {
  github: null,
  wrangler: null,
  cf: null,
  repository: null,
  workersSubdomain: null,
  zones: [],
  accessOrganization: null,
  kvNamespaces: { production: null, preview: null },
  accessApps: { allow: null, bypass: null },
  githubOAuth: { production: null, preview: null },
  apiToken: { saved: false, valid: null },
  workerSecrets: null,
  previewSecrets: [],
  githubSecrets: [],
  githubVariables: {},
  pushed: false,
  deploy: null,
  live: null,
};

/** What a remote probe can read: the answers, the cached state, and the facts found so far. */
export type ProbeInput = {
  root: string;
  answers: Answers;
  local: LocalState;
  origin: { owner: string; name: string };
  apiTokenFile: string;
  /** The facts from the probes that ran earlier in `REMOTE_PROBES` order. */
  facts: RemoteFacts;
};

/** A probe for one field of `RemoteFacts`. */
export type RemoteProbe<K extends keyof RemoteFacts> = (
  input: ProbeInput,
) => RemoteFacts[K] | Promise<RemoteFacts[K]>;

function notBuilt<K extends keyof RemoteFacts>(field: K): RemoteProbe<K> {
  return () => {
    throw new NotBuiltError(`The ${field} probe`);
  };
}

/**
 * The remote probes, which run in this order on every run outside fixture mode. Each receives
 * the facts that the earlier probes found, so a probe can skip its call when a login or an
 * account is missing and return the empty value from `EMPTY_FACTS` instead.
 *
 * The remote half of setup replaces each `notBuilt` entry with a probe that calls `gh`,
 * `wrangler`, `cf`, or the deployed Worker. The probes never print a secret value.
 */
export const REMOTE_PROBES: { [K in keyof RemoteFacts]: RemoteProbe<K> } = {
  github: notBuilt("github"),
  wrangler: notBuilt("wrangler"),
  cf: notBuilt("cf"),
  repository: notBuilt("repository"),
  workersSubdomain: notBuilt("workersSubdomain"),
  zones: notBuilt("zones"),
  accessOrganization: notBuilt("accessOrganization"),
  kvNamespaces: notBuilt("kvNamespaces"),
  accessApps: notBuilt("accessApps"),
  githubOAuth: notBuilt("githubOAuth"),
  apiToken: notBuilt("apiToken"),
  workerSecrets: notBuilt("workerSecrets"),
  previewSecrets: notBuilt("previewSecrets"),
  githubSecrets: notBuilt("githubSecrets"),
  githubVariables: notBuilt("githubVariables"),
  pushed: notBuilt("pushed"),
  deploy: notBuilt("deploy"),
  live: notBuilt("live"),
};

// Runs the probes one after another, because each one reads the facts of the earlier ones.
async function probeRemote(base: Omit<ProbeInput, "facts">): Promise<RemoteFacts> {
  const facts: RemoteFacts = structuredClone(EMPTY_FACTS);
  const input: ProbeInput = { ...base, facts };
  const probes = REMOTE_PROBES;
  facts.github = await probes.github(input);
  facts.wrangler = await probes.wrangler(input);
  facts.cf = await probes.cf(input);
  facts.repository = await probes.repository(input);
  facts.workersSubdomain = await probes.workersSubdomain(input);
  facts.zones = await probes.zones(input);
  facts.accessOrganization = await probes.accessOrganization(input);
  facts.kvNamespaces = await probes.kvNamespaces(input);
  facts.accessApps = await probes.accessApps(input);
  facts.githubOAuth = await probes.githubOAuth(input);
  facts.apiToken = await probes.apiToken(input);
  facts.workerSecrets = await probes.workerSecrets(input);
  facts.previewSecrets = await probes.previewSecrets(input);
  facts.githubSecrets = await probes.githubSecrets(input);
  facts.githubVariables = await probes.githubVariables(input);
  facts.pushed = await probes.pushed(input);
  facts.deploy = await probes.deploy(input);
  facts.live = await probes.live(input);
  return facts;
}

/**
 * Reads the fixed facts from a fixture file. Fields that the file leaves out keep their empty
 * values, so a fixture names only what exists in its pretend accounts.
 */
export function readFixture(file: string): RemoteFacts {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RefusalError(`The fixture ${file} must hold a JSON object.`);
  }
  const facts: RemoteFacts = structuredClone(EMPTY_FACTS);
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(EMPTY_FACTS, key)) {
      throw new RefusalError(`The fixture ${file} has an unknown field, ${key}.`);
    }
    Object.assign(facts, { [key]: value });
  }
  return facts;
}

const ORIGIN = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** The owner and name from the `origin` remote. Refuses the template and names Workers can't use. */
export function readOrigin(root: string): { owner: string; name: string } {
  let url: string;
  try {
    url = read(root, "git", ["remote", "get-url", "origin"]).trim();
  } catch {
    throw new RefusalError(
      "The repository has no origin remote. Create the project's GitHub repository from the template and clone it, as SETUP.md describes, then run the script in that clone.",
    );
  }
  const match = ORIGIN.exec(url);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new RefusalError(`The origin remote, ${url}, isn't a GitHub repository.`);
  }
  const origin = { owner: match[1], name: match[2] };
  if (`${origin.owner}/${origin.name}`.toLowerCase() === TEMPLATE_REPOSITORY) {
    throw new RefusalError(
      `The origin remote is the template itself, ${TEMPLATE_REPOSITORY}. Setup changes the repository it runs in, so run it only in a project created from the template.`,
    );
  }
  if (!PROJECT_NAME.test(origin.name)) {
    throw new RefusalError(
      `The repository name ${origin.name} can't name a Worker. Use lowercase letters, digits, and hyphens, starting with a letter, at most 40 characters, and create the repository again.`,
    );
  }
  return origin;
}

function exists(root: string, file: string): boolean {
  return existsSync(path.join(root, file));
}

/** The files that Git tracks or would add, relative to the root. */
export function listFiles(root: string): string[] {
  return read(root, "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter((file) => file !== "" && exists(root, file))
    .toSorted();
}

/** Whether a path belongs to the setup script, which the rename leaves alone. */
export function isSetupFile(file: string): boolean {
  return file === "scripts/setup.ts" || file.startsWith("scripts/setup/") || file === "SETUP.md";
}

const TEMPLATE_NAMES = /(?<!mckalexee\/)cloudflare-starter|Cloudflare Starter/;

function isText(buffer: Uint8Array): boolean {
  return !buffer.subarray(0, 8000).includes(0);
}

/** The files outside the setup script that still name the template. */
export function renameLeftovers(root: string): string[] {
  return listFiles(root).filter((file) => {
    if (isSetupFile(file)) {
      return false;
    }
    const buffer = readFileSync(path.join(root, file));
    return isText(buffer) && TEMPLATE_NAMES.test(buffer.toString("utf8"));
  });
}

/** What the working tree says about the prune step. */
export function readTree(root: string): TreeFacts {
  const parts: Part[] = [];
  if (exists(root, "src/mcp")) {
    parts.push("mcp");
  }
  if (exists(root, "src/web")) {
    parts.push("web");
  }
  let signIn: SignIn | null = null;
  if (parts.includes("mcp")) {
    const app = path.join(root, "src/http/index.ts");
    if (exists(root, "src/auth/provider.ts")) {
      signIn = "github";
    } else if (existsSync(app) && readFileSync(app, "utf8").includes(`from "#auth/access.ts"`)) {
      signIn = "access";
    } else {
      signIn = "bearer";
    }
  }
  return { parts, signIn, pristine: parts.length === 2 && signIn === "github" };
}

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A hash of the files that decide what `pnpm install` does. */
export function manifestHash(root: string): string {
  return sha256(
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
      .map((file) => (exists(root, file) ? readFileSync(path.join(root, file), "utf8") : ""))
      .join("\0"),
  );
}

/** A hash of every file that Git tracks or would add, for "verify passed on this tree". */
export function treeFingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    hash.update(`${file}\0${sha256(readFileSync(path.join(root, file)))}\0`);
  }
  return hash.digest("hex");
}

/** Parses `.dev.vars` into its keys and values. Missing file means no keys. */
export function readDevVars(root: string): Map<string, string> {
  const file = path.join(root, ".dev.vars");
  const values = new Map<string, string>();
  if (!existsSync(file)) {
    return values;
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      values.set(match[1], (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return values;
}

function hashValues(values: (string | undefined)[]): string | null {
  return values.every((value) => value !== undefined && value !== "")
    ? sha256(JSON.stringify(values))
    : null;
}

/**
 * Hashes of the current source of each secret target. The script stores the hash of what it
 * uploaded, so a changed source uploads again. The production cookie secret is generated at
 * upload time, so only the GitHub pair or the bearer token count.
 */
export function secretSources(
  answers: Answers,
  devVars: Map<string, string>,
  apiTokenFile: string,
): Record<SecretTarget, string | null> {
  const mode = answers.parts?.includes("mcp") === true ? answers["sign-in"] : undefined;
  const token = existsSync(apiTokenFile) ? readFileSync(apiTokenFile, "utf8").trim() : undefined;
  const pick = (...keys: string[]) => hashValues(keys.map((key) => devVars.get(key)));
  return {
    production:
      mode === "github"
        ? pick("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET")
        : mode === "bearer"
          ? pick("MCP_BEARER_TOKEN")
          : null,
    preview:
      mode === "github"
        ? pick("PREVIEW_GITHUB_CLIENT_ID", "PREVIEW_GITHUB_CLIENT_SECRET")
        : mode === "bearer"
          ? pick("MCP_BEARER_TOKEN")
          : null,
    apiToken: hashValues([token]),
  };
}

/** The file outside the repository where the person saves the API token for GitHub Actions. */
export function apiTokenPath(origin: { owner: string; name: string }): string {
  return path.join(
    homedir(),
    ".config",
    `setup-${origin.owner}-${origin.name}`,
    "cloudflare-api-token",
  );
}

function readWranglerVersion(root: string): string {
  const pkg: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (typeof pkg === "object" && pkg !== null && "devDependencies" in pkg) {
    const deps = pkg.devDependencies;
    if (
      typeof deps === "object" &&
      deps !== null &&
      "wrangler" in deps &&
      typeof deps.wrangler === "string"
    ) {
      return deps.wrangler;
    }
  }
  return "latest";
}

/**
 * Reads everything the planner needs. Outside fixture mode the remote probes run for real, so
 * this can take a few seconds and needs the network.
 */
export async function loadContext(root: string, fixtureFile: string | undefined): Promise<Context> {
  const origin = readOrigin(root);
  const local = readLocal(root);
  const answers = mergedAnswers(root, local);
  const tokenFile = apiTokenPath(origin);
  const facts =
    fixtureFile === undefined
      ? await probeRemote({ root, answers, local, origin, apiTokenFile: tokenFile })
      : readFixture(fixtureFile);
  const devVars = readDevVars(root);
  const wrangler = exists(root, "wrangler.jsonc")
    ? readFileSync(path.join(root, "wrangler.jsonc"), "utf8")
    : "";
  const repo: RepoFacts = {
    root,
    origin,
    wranglerVersion: readWranglerVersion(root),
    agentsBlock:
      exists(root, "AGENTS.md") &&
      readFileSync(path.join(root, "AGENTS.md"), "utf8").includes(AGENTS_BLOCK_START),
    renameLeftovers: renameLeftovers(root),
    tree: readTree(root),
    installed:
      exists(root, "node_modules/.modules.yaml") && local.installedFor === manifestHash(root),
    configuredHost: configuredHost(wrangler),
    configPending: [],
    devVars: Object.fromEntries([...devVars].map(([key, value]) => [key, value !== ""])),
    secretSources: secretSources(answers, devVars, tokenFile),
    verified: local.verifiedFingerprint === treeFingerprint(root),
    clean: read(root, "git", ["status", "--porcelain"]).trim() === "",
    apiTokenFile: tokenFile,
  };
  const ctx: Context = { answers, local, repo, facts, fixture: fixtureFile !== undefined };
  repo.configPending = pendingConfig(ctx);
  return ctx;
}
