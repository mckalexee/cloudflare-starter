// The probes that read the state of the run on every invocation. Local probes read the
// repository and always run for real. Remote probes read GitHub, Cloudflare, and the deployed
// Worker, each only when the planner first reads its fact, and `SETUP_FIXTURE=<file>` replaces
// all of them with the fixed facts in that file. `loadContext()` hands the planner one `Context`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { AGENTS_BLOCK_START, configuredHost, pendingConfig } from "./config.ts";
import { TEMPLATE_REPOSITORY } from "./derive.ts";
import { read } from "./exec.ts";
import { REAL_PROBES } from "./remote.ts";
import { mergedAnswers, readDevVars, readLocal, readResources } from "./state.ts";
import type {
  Answers,
  Context,
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
  worker: null,
  repoDeployed: false,
};

/**
 * Facts that run their probe the first time something reads them, and keep the answer for the
 * rest of the run. A probe can read other facts, which run their own probes in turn.
 */
function lazyFacts(ctx: () => Context): RemoteFacts {
  const facts: RemoteFacts = structuredClone(EMPTY_FACTS);
  for (const key of Object.keys(EMPTY_FACTS)) {
    let value: unknown;
    let done = false;
    Object.defineProperty(facts, key, {
      enumerable: true,
      get: () => {
        if (!done) {
          value = (REAL_PROBES as Record<string, (context: Context) => unknown>)[key]?.(ctx());
          done = true;
        }
        return value;
      },
      set: (next: unknown) => {
        value = next;
        done = true;
      },
    });
  }
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

// HTTPS, `git@github.com:`, and `ssh://git@github.com/` forms, and nothing else.
const ORIGIN =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** The owner and name from the `origin` remote. Refuses the template and names Workers can't use. */
export function readOrigin(root: string): { owner: string; name: string } {
  let url: string;
  try {
    // The configured URL, before any `url.<base>.insteadOf` rewriting.
    url = read(root, "git", ["config", "--get", "remote.origin.url"]).trim();
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

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function exists(root: string, file: string): boolean {
  return existsSync(path.join(root, file));
}

/** The files that Git tracks or would add, relative to the root. */
export function listFiles(root: string): string[] {
  return (
    read(root, "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .split("\0")
      // Only regular files: a symbolic link to a folder, such as a linked `node_modules`, would
      // otherwise show up as an untracked path.
      .filter((file) => file !== "" && isFile(path.join(root, file)))
      .toSorted()
  );
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

/** The marker of a Cloudflare API token that `cf` and Wrangler would use instead of the logins. */
function apiTokenOverride(root: string): string | undefined {
  if ((process.env.CLOUDFLARE_API_TOKEN ?? "") !== "") {
    return "the environment";
  }
  const env = path.join(root, ".env");
  return existsSync(env) && /^\s*CLOUDFLARE_API_TOKEN\s*=\s*\S/m.test(readFileSync(env, "utf8"))
    ? "the project's .env file"
    : undefined;
}

/** The `origin` owner that fixture mode requires, so a fixture never touches a real project. */
export const FIXTURE_OWNER = "example";

function gitEmail(root: string): string | null {
  try {
    const email = read(root, "git", ["config", "user.email"]).trim();
    return email === "" ? null : email;
  } catch {
    return null;
  }
}

/** Where `loadContext()` reads from. */
export type ContextOptions = {
  /** The fixture file that replaces the remote probes. */
  fixture?: string;
  /** The folder that holds `setup.json` and `setup.local.json`, if it isn't the root. */
  stateRoot?: string;
};

/**
 * Reads everything the planner needs. Outside fixture mode the remote probes run for real when
 * the planner first reads their facts, so a run can take a few seconds and needs the network.
 */
export function loadContext(root: string, options: ContextOptions = {}): Context {
  const origin = readOrigin(root);
  const override = apiTokenOverride(root);
  if (override !== undefined) {
    throw new RefusalError(
      `CLOUDFLARE_API_TOKEN is set in ${override}. The Cloudflare CLI and Wrangler would use that token instead of the logins that setup checks. Remove it, then run the script again.`,
    );
  }
  if (options.fixture !== undefined && origin.owner !== FIXTURE_OWNER) {
    throw new RefusalError(
      `Fixture mode fills a project with fake IDs and skips every check of GitHub and Cloudflare, so it runs only in a scratch copy whose origin owner is ${FIXTURE_OWNER}, such as https://github.com/${FIXTURE_OWNER}/${origin.name}.git. This origin's owner is ${origin.owner}.`,
    );
  }
  const stateRoot = options.stateRoot ?? root;
  const local = readLocal(stateRoot);
  const answers = mergedAnswers(stateRoot, local);
  const tokenFile = apiTokenPath(origin);
  const devVars = readDevVars(root);
  const wrangler = exists(root, "wrangler.jsonc")
    ? readFileSync(path.join(root, "wrangler.jsonc"), "utf8")
    : "";
  const repo = {
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
    devVars: Object.fromEntries([...devVars].map(([key, value]) => [key, value !== ""])),
    secretSources: secretSources(answers, devVars, tokenFile),
    verified: local.verifiedFingerprint === treeFingerprint(root),
    clean: read(root, "git", ["status", "--porcelain"]).trim() === "",
    apiTokenFile: tokenFile,
    configPending: [],
    gitEmail: gitEmail(root),
  } satisfies RepoFacts;
  const fixture = options.fixture;
  const ctx: Context = {
    resources: readResources(stateRoot),
    answers,
    local,
    repo,
    facts: fixture === undefined ? lazyFacts(() => ctx) : readFixture(fixture),
    fixture: fixture !== undefined,
  };
  // The config edits read facts, such as KV namespace IDs, so they wait until the planner asks.
  let pending: string[] | undefined;
  Object.defineProperty(repo, "configPending", {
    enumerable: true,
    get: () => (pending ??= pendingConfig(ctx)),
    set: (next: string[]) => {
      pending = next;
    },
  });
  return ctx;
}
