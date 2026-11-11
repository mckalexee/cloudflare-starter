// The work steps that the script runs itself. Each step is idempotent: the planner runs it only
// while its check is open, and running it again after a failure finishes the job. Each one prints
// its command or edit before it acts. Local steps change only the working tree. Remote steps call
// GitHub and Cloudflare, and fixture mode skips them.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { addAgentsBlock, configEdits } from "./config.ts";
import {
  accessUsed,
  accountLabel,
  customDomain,
  desiredAccessApps,
  devVarKeys,
  hasMcp,
  host,
  parts,
  previewSecretNames,
  signIn,
  workerSecretNames,
  workersSubdomain,
} from "./derive.ts";
import { read, run, say, StepError } from "./exec.ts";
import { isSetupFile, manifestHash, renameLeftovers, treeFingerprint } from "./probes.ts";
import { REMOTE_STEPS } from "./remote-steps.ts";
import { LOCAL_FILE, updateLocal } from "./state.ts";
import type { Context, StepId } from "./types.ts";

/** One work step. */
export type StepSpec = {
  id: StepId;
  /** One sentence that says what the step does, printed before it runs. */
  title: (ctx: Context) => string;
  remote: boolean;
  run: (ctx: Context) => void;
};

function edit(root: string, file: string, change: (text: string) => string): boolean {
  const full = path.join(root, file);
  const text = readFileSync(full, "utf8");
  const next = change(text);
  if (next === text) {
    return false;
  }
  writeFileSync(full, next);
  return true;
}

function remote(id: keyof typeof REMOTE_STEPS, title: (ctx: Context) => string): StepSpec {
  return { id, title, remote: true, run: REMOTE_STEPS[id] };
}

/** The lines of the summary that the script prints before its first change. */
export function summaryLines(ctx: Context): string[] {
  const { owner, name } = ctx.repo.origin;
  const hostname = host(ctx) ?? "<host>";
  const lines: string[] = [`In GitHub, in ${owner}/${name}:`];
  lines.push(
    "- Repository secrets CLOUDFLARE_API_TOKEN, from the token file, and CLOUDFLARE_ACCOUNT_ID.",
    `- Repository variables DEPLOY_ENABLED set to true and HEALTHCHECK_URL set to https://${hostname}.`,
  );
  if ((ctx.answers.description ?? "") !== "") {
    lines.push(`- The repository description: ${ctx.answers.description ?? ""}`);
  }
  lines.push("- A push to main, which deploys production through the deploy workflow.");
  lines.push("", `In Cloudflare, in the account ${accountLabel(ctx)}:`);
  if (ctx.facts.workersSubdomain === null) {
    lines.push(`- The workers.dev subdomain ${workersSubdomain(ctx) ?? "<subdomain>"}.`);
  }
  if (hasMcp(ctx.answers)) {
    lines.push(`- KV namespaces ${name}-kv for production and ${name}-kv-preview for Previews.`);
  }
  if (accessUsed(ctx.answers) && ctx.answers["access-otp"] === "yes") {
    lines.push("- The one-time PIN login method in the Zero Trust organization.");
  }
  const apps = desiredAccessApps(ctx);
  if (apps !== null) {
    lines.push(
      `- The Access application ${apps.allow.name} on ${apps.allow.domain}` +
        (apps.allow.managedOAuth ? ", with Managed OAuth for MCP clients," : "") +
        " that admits the people you named.",
    );
    if (apps.bypass !== null) {
      lines.push(
        `- The Access application ${apps.bypass.name}, which leaves ${apps.bypass.destinations.join(", ")} open.`,
      );
    }
  }
  lines.push(
    `- The Worker ${name} on ${hostname}` +
      (customDomain(ctx.answers) ? ", with a custom domain route" : "") +
      ", created by its first secret upload or its first deploy.",
  );
  const workerSecrets = workerSecretNames(ctx.answers);
  if (workerSecrets.length > 0) {
    lines.push(`- Worker secrets ${workerSecrets.join(", ")}.`);
  }
  const previewSecrets = previewSecretNames(ctx.answers);
  if (previewSecrets.length > 0) {
    lines.push(`- Preview base config secrets ${previewSecrets.join(", ")}.`);
  }
  const selection = [`--parts ${ctx.answers.parts ?? ""}`];
  const mode = signIn(ctx.answers);
  if (mode !== undefined) {
    selection.push(`--sign-in ${mode}`);
  }
  lines.push(
    "",
    "In the project folder:",
    "- A block at the top of AGENTS.md that says setup isn't finished.",
    `- The template's name replaced with ${name} and ${ctx.answers["display-name"] ?? name}.`,
    `- The template pruned with ${selection.join(" ")}, then pnpm install.`,
    "- The configuration edits, .dev.vars, pnpm verify, and a commit.",
  );
  return lines;
}

function commitSubject(ctx: Context): string {
  const first = `Set up ${ctx.repo.origin.name} from the template`;
  const log = read(ctx.repo.root, "git", ["log", "--format=%s"]);
  return log.split("\n").includes(first) ? `Update the setup of ${ctx.repo.origin.name}` : first;
}

const SECRET_FILES = /(^|\/)(\.dev\.vars[^/]*|\.env[^/]*|setup\.local\.json)$/;

// Files in the index that `.gitignore` covers, or that hold secrets by name. Either kind can
// carry a secret into a commit.
function stagedSecretFiles(root: string): string[] {
  const ignored = read(root, "git", ["ls-files", "--cached", "--ignored", "--exclude-standard"])
    .split("\n")
    .filter((file) => file !== "");
  const named = read(root, "git", ["ls-files", "--cached"])
    .split("\n")
    .filter((file) => SECRET_FILES.test(file) && !file.endsWith(".example"));
  return [...new Set([...ignored, ...named])].toSorted();
}

/** Every step, keyed by ID. */
export const STEPS: Record<StepId, StepSpec> = {
  summary: {
    id: "summary",
    title: () =>
      "Summarize what setup creates. Relay this summary to the person before the next run.",
    remote: false,
    run: (ctx) => {
      for (const line of summaryLines(ctx)) {
        say(line);
      }
      updateLocal(ctx.repo.root, (state) => {
        state.summaryShown = true;
      });
    },
  },
  "agents-block": {
    id: "agents-block",
    title: () => "Mark the project as unfinished at the top of AGENTS.md.",
    remote: false,
    run: (ctx) => {
      say("Edit AGENTS.md: add the block that says setup isn't finished.");
      edit(ctx.repo.root, "AGENTS.md", addAgentsBlock);
    },
  },
  rename: {
    id: "rename",
    title: (ctx) =>
      `Replace the template's name with ${ctx.repo.origin.name} and its display name with ${ctx.answers["display-name"] ?? ""}.`,
    remote: false,
    run: (ctx) => {
      const { root } = ctx.repo;
      const name = ctx.repo.origin.name;
      const display = ctx.answers["display-name"] ?? name;
      for (const file of renameLeftovers(root)) {
        if (isSetupFile(file)) {
          continue;
        }
        say(`Edit ${file}: replace cloudflare-starter and Cloudflare Starter.`);
        edit(root, file, (text) =>
          text
            .replaceAll(/(?<!mckalexee\/)cloudflare-starter/g, name)
            .replaceAll("Cloudflare Starter", display),
        );
      }
    },
  },
  prune: {
    id: "prune",
    title: () => "Remove the code for the parts and the sign-in mode that the project doesn't use.",
    remote: false,
    run: (ctx) => {
      const selection = parts(ctx.answers) ?? [];
      const args = ["scripts/prune.ts", "--parts", selection.join(",")];
      const mode = signIn(ctx.answers);
      if (mode !== undefined) {
        args.push("--sign-in", mode);
      }
      run(ctx.repo.root, process.execPath, args, { display: `node ${args.join(" ")}` });
    },
  },
  install: {
    id: "install",
    title: () => "Install the dependencies and update the lockfile for the pruned project.",
    remote: false,
    run: (ctx) => {
      // CI sets `CI`, which makes pnpm refuse to change the lockfile unless told to.
      run(ctx.repo.root, "pnpm", ["install", "--no-frozen-lockfile"]);
      updateLocal(ctx.repo.root, (state) => {
        state.installedFor = manifestHash(ctx.repo.root);
      });
    },
  },
  "workers-subdomain": remote(
    "workers-subdomain",
    (ctx) => `Create the workers.dev subdomain ${workersSubdomain(ctx) ?? ""} for the account.`,
  ),
  "kv-namespaces": remote(
    "kv-namespaces",
    (ctx) =>
      `Create the KV namespaces ${ctx.repo.origin.name}-kv and ${ctx.repo.origin.name}-kv-preview.`,
  ),
  "access-otp": remote(
    "access-otp",
    () => "Add the one-time PIN login method to the Zero Trust organization.",
  ),
  "access-apps": remote("access-apps", () => "Create or update the Access applications."),
  config: {
    id: "config",
    title: () => "Write the answers and the account IDs into the configuration.",
    remote: false,
    run: (ctx) => {
      for (const change of configEdits(ctx)) {
        if (edit(ctx.repo.root, change.file, change.apply)) {
          say(`Edit ${change.file}.`);
        }
      }
    },
  },
  "dev-vars": {
    id: "dev-vars",
    title: () => "Generate the local secrets in .dev.vars.",
    remote: false,
    run: (ctx) => {
      const file = path.join(ctx.repo.root, ".dev.vars");
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
      if (lines.at(-1) === "") {
        lines.pop();
      }
      for (const key of devVarKeys(ctx.answers).generated) {
        const index = lines.findIndex((line) => line.startsWith(`${key}=`));
        if (index !== -1 && lines[index] !== `${key}=`) {
          continue;
        }
        say(`Edit .dev.vars: set ${key} to 32 random bytes in hex.`);
        const entry = `${key}=${randomBytes(32).toString("hex")}`;
        if (index === -1) {
          lines.push(entry);
        } else {
          lines[index] = entry;
        }
      }
      writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    },
  },
  verify: {
    id: "verify",
    title: () => "Run pnpm verify on the working tree.",
    remote: false,
    run: (ctx) => {
      run(ctx.repo.root, "pnpm", ["verify"]);
      updateLocal(ctx.repo.root, (state) => {
        state.verifiedFingerprint = treeFingerprint(ctx.repo.root);
      });
    },
  },
  commit: {
    id: "commit",
    title: () => "Commit the setup changes.",
    remote: false,
    run: (ctx) => {
      const { root } = ctx.repo;
      run(root, "git", ["add", "--all"]);
      const secrets = stagedSecretFiles(root);
      if (secrets.length > 0) {
        throw new StepError(
          `The index holds files that can carry secrets: ${secrets.join(", ")}. Remove each from the index with \`git rm --cached <file>\`, check that .gitignore covers it, and run the script again. ${LOCAL_FILE} and .dev.vars must never be committed.`,
        );
      }
      run(root, "git", ["commit", "--quiet", "-m", commitSubject(ctx)]);
    },
  },
  "worker-secrets": remote("worker-secrets", (ctx) => {
    const names = workerSecretNames(ctx.answers).join(", ");
    return `Upload the production Worker secrets ${names}.`;
  }),
  "preview-secrets": remote("preview-secrets", (ctx) => {
    const names = previewSecretNames(ctx.answers).join(", ");
    return `Upload the Preview base config secrets ${names}.`;
  }),
  "github-secrets": remote(
    "github-secrets",
    () => "Set the repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
  ),
  "github-variables": remote(
    "github-variables",
    () => "Set the repository variables DEPLOY_ENABLED and HEALTHCHECK_URL.",
  ),
  "repository-description": remote(
    "repository-description",
    () => "Set the repository description.",
  ),
  push: remote("push", () => "Push main to GitHub, which starts the deploy workflow."),
  "deploy-rerun": remote("deploy-rerun", () => "Rerun the failed deploy job once."),
  "deploy-failed": remote(
    "deploy-failed",
    () => "Show the log of the deploy job, which failed twice.",
  ),
  "live-checks": remote("live-checks", () => "Report the live checks that failed."),
};
