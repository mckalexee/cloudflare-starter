// The planner: a pure function from the answers and the probed facts to the one next action. It
// walks an ordered list of checks, from the first login to the last live check, and returns the
// action of the first check that applies and isn't satisfied yet. It returns `done` only when no
// check is open, and `finishBlockers()` uses the same list, so `finish` and `done` can't disagree.
import {
  accessUsed,
  desiredAccessApps,
  devVarKeys,
  hasMcp,
  host,
  previewSecretNames,
  workerSecretNames,
  type DesiredAccessApp,
} from "./derive.ts";
import { QUESTIONS, question, treeMatches } from "./questions.ts";
import { task, TASKS } from "./tasks.ts";
import type { AccessAppFact, Action, Context, StepId, TaskId } from "./types.ts";

/** One check in the run: a question, a person task, a work step, or the deploy. */
type Item = {
  /** A stable name, such as `question:parts` or `step:prune`, for tests and messages. */
  id: string;
  /** Remote steps are off in fixture mode, which records them as skipped instead. */
  remote: StepId | undefined;
  applies: (ctx: Context) => boolean;
  satisfied: (ctx: Context) => boolean;
  action: (ctx: Context) => Action;
};

/** The remote steps that fixture mode skipped, from `setup.local.json`. */
export function skippedSteps(ctx: Context): Set<string> {
  if (!ctx.fixture) {
    return new Set();
  }
  return new Set((ctx.local.fixtureSkipped ?? "").split(",").filter((step) => step !== ""));
}

function questionItem(key: Parameters<typeof question>[0]): Item {
  const spec = question(key);
  return {
    id: `question:${key}`,
    remote: undefined,
    applies: (ctx) => spec.applies(ctx.answers) && spec.needed(ctx),
    satisfied: (ctx) => ctx.answers[key] !== undefined && spec.invalid(ctx) === undefined,
    action: (ctx) => ({
      kind: "question",
      key,
      problem: ctx.answers[key] === undefined ? undefined : spec.invalid(ctx),
    }),
  };
}

function taskItem(id: TaskId): Item {
  const spec = task(id);
  return {
    id: `task:${id}`,
    remote: undefined,
    applies: spec.applies,
    satisfied: spec.done,
    action: (ctx) => ({ kind: "task", id, remaining: remainingTasks(ctx, spec.block) }),
  };
}

function stepItem(
  id: StepId,
  options: {
    remote?: boolean;
    applies?: (ctx: Context) => boolean;
    satisfied: (ctx: Context) => boolean;
  },
): Item {
  const remote = options.remote ?? false;
  return {
    id: `step:${id}`,
    remote: remote ? id : undefined,
    applies: options.applies ?? (() => true),
    satisfied: options.satisfied,
    action: () => ({ kind: "step", id, remote }),
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].toSorted();
  const right = [...new Set(b)].toSorted();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Whether an Access application read back from Cloudflare matches the one the answers need. */
export function appMatches(fact: AccessAppFact | null, desired: DesiredAccessApp | null): boolean {
  if (desired === null) {
    return fact === null;
  }
  return (
    fact !== null &&
    fact.domain === desired.domain &&
    fact.managedOAuth === desired.managedOAuth &&
    sameSet(fact.destinations, desired.destinations) &&
    sameSet(fact.include, desired.include)
  );
}

function hashMatches(ctx: Context, target: "production" | "preview" | "apiToken"): boolean {
  const source = ctx.repo.secretSources[target];
  return source !== null && ctx.local.secretHashes[target] === source;
}

function includesAll(names: readonly string[] | null, wanted: readonly string[]): boolean {
  return names !== null && wanted.every((name) => names.includes(name));
}

/**
 * The whole run, in order. The questions that need no account come first, so every person task
 * is known before the first one, and the task count only goes down. The logins follow, because
 * the remaining questions suggest answers from the accounts. Then the other person tasks and the
 * summary, so the person's work comes in one block before the script changes anything. The
 * script's own steps follow, and the two last tasks end the run.
 */
const ITEMS: Item[] = [
  questionItem("display-name"),
  questionItem("parts"),
  questionItem("sign-in"),
  questionItem("web-access"),
  questionItem("who-may-sign-in"),
  questionItem("oauth-previews"),
  questionItem("license"),
  taskItem("login-github"),
  taskItem("login-wrangler"),
  questionItem("description"),
  questionItem("allowed-github"),
  questionItem("cloudflare-account"),
  questionItem("workers-subdomain"),
  questionItem("hostname"),
  taskItem("login-cf"),
  taskItem("zero-trust-org"),
  questionItem("access-otp"),
  taskItem("github-oauth-app"),
  taskItem("github-oauth-app-previews"),
  taskItem("cloudflare-api-token"),
  stepItem("summary", { satisfied: (ctx) => ctx.local.summaryShown === true }),
  stepItem("agents-block", { satisfied: (ctx) => ctx.repo.agentsBlock }),
  stepItem("rename", { satisfied: (ctx) => ctx.repo.renameLeftovers.length === 0 }),
  stepItem("prune", { satisfied: (ctx) => treeMatches(ctx.repo.tree, ctx.answers) }),
  stepItem("install", { satisfied: (ctx) => ctx.repo.installed }),
  stepItem("workers-subdomain", {
    remote: true,
    satisfied: (ctx) => ctx.facts.workersSubdomain !== null,
  }),
  stepItem("kv-namespaces", {
    remote: true,
    applies: (ctx) => hasMcp(ctx.answers),
    satisfied: (ctx) =>
      ctx.facts.kvNamespaces.production !== null && ctx.facts.kvNamespaces.preview !== null,
  }),
  stepItem("access-otp", {
    remote: true,
    applies: (ctx) => accessUsed(ctx.answers) && ctx.answers["access-otp"] === "yes",
    satisfied: (ctx) => ctx.facts.accessOrganization?.hasOneTimePin === true,
  }),
  stepItem("access-apps", {
    remote: true,
    applies: (ctx) => accessUsed(ctx.answers),
    satisfied: (ctx) => {
      const desired = desiredAccessApps(ctx);
      return (
        desired !== null &&
        appMatches(ctx.facts.accessApps.allow, desired.allow) &&
        appMatches(ctx.facts.accessApps.bypass, desired.bypass)
      );
    },
  }),
  stepItem("config", { satisfied: (ctx) => ctx.repo.configPending.length === 0 }),
  stepItem("dev-vars", {
    applies: (ctx) => devVarKeys(ctx.answers).generated.length > 0,
    satisfied: (ctx) =>
      devVarKeys(ctx.answers).generated.every((key) => ctx.repo.devVars[key] === true),
  }),
  stepItem("verify", { satisfied: (ctx) => ctx.repo.verified }),
  stepItem("commit", { satisfied: (ctx) => ctx.repo.clean }),
  stepItem("worker-secrets", {
    remote: true,
    applies: (ctx) => workerSecretNames(ctx.answers).length > 0,
    satisfied: (ctx) =>
      includesAll(ctx.facts.workerSecrets, workerSecretNames(ctx.answers)) &&
      hashMatches(ctx, "production"),
  }),
  stepItem("preview-secrets", {
    remote: true,
    applies: (ctx) => previewSecretNames(ctx.answers).length > 0,
    satisfied: (ctx) =>
      includesAll(ctx.facts.previewSecrets, previewSecretNames(ctx.answers)) &&
      hashMatches(ctx, "preview"),
  }),
  stepItem("github-secrets", {
    remote: true,
    satisfied: (ctx) =>
      includesAll(ctx.facts.githubSecrets, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) &&
      hashMatches(ctx, "apiToken"),
  }),
  stepItem("github-variables", {
    remote: true,
    satisfied: (ctx) =>
      ctx.facts.githubVariables.DEPLOY_ENABLED === "true" &&
      ctx.facts.githubVariables.HEALTHCHECK_URL === `https://${host(ctx) ?? ""}`,
  }),
  stepItem("repository-description", {
    remote: true,
    satisfied: (ctx) => ctx.facts.repository?.description === (ctx.answers.description ?? ""),
  }),
  stepItem("push", { remote: true, satisfied: (ctx) => ctx.facts.pushed }),
  {
    id: "deploy",
    remote: undefined,
    applies: () => true,
    satisfied: (ctx) => ctx.facts.deploy?.status === "success",
    action: (ctx) => {
      const deploy = ctx.facts.deploy;
      if (deploy === null || deploy.status === "pending") {
        return { kind: "wait", id: "deploy", url: deploy?.url };
      }
      // A failed deploy job gets one rerun before the script stops and shows its log.
      return deploy.attempts < 2
        ? { kind: "step", id: "deploy-rerun", remote: true }
        : { kind: "step", id: "deploy-failed", remote: true };
    },
  },
  stepItem("live-checks", {
    remote: true,
    satisfied: (ctx) => ctx.facts.live !== null && ctx.facts.live.every((check) => check.ok),
  }),
  taskItem("mcp-client"),
  taskItem("renovate"),
];

// Every question and task must have a place in the run, or the planner could never ask for it.
for (const id of [
  ...QUESTIONS.map((spec) => `question:${spec.key}`),
  ...TASKS.map((spec) => `task:${spec.id}`),
]) {
  if (!ITEMS.some((item) => item.id === id)) {
    throw new Error(`${id} has no place in the planner.`);
  }
}

function isOpen(item: Item, ctx: Context, skipped: Set<string>): boolean {
  if (!item.applies(ctx) || item.satisfied(ctx)) {
    return false;
  }
  return item.remote === undefined || !skipped.has(item.remote);
}

/** How many person tasks in a block are still open, the current one included. */
export function remainingTasks(ctx: Context, block: "first" | "last"): number {
  return TASKS.filter((spec) => spec.block === block && spec.applies(ctx) && !spec.done(ctx))
    .length;
}

/** The IDs of every check that applies and isn't satisfied, in run order. */
export function openChecks(ctx: Context): string[] {
  const skipped = skippedSteps(ctx);
  return ITEMS.filter((item) => isOpen(item, ctx, skipped)).map((item) => item.id);
}

/** The next action: the action of the first open check, or `done` when no check is open. */
export function plan(ctx: Context): Action {
  const skipped = skippedSteps(ctx);
  const next = ITEMS.find((item) => isOpen(item, ctx, skipped));
  if (next !== undefined) {
    return next.action(ctx);
  }
  const skippedHere = ITEMS.flatMap((item) =>
    item.remote !== undefined &&
    skipped.has(item.remote) &&
    item.applies(ctx) &&
    !item.satisfied(ctx)
      ? [item.remote]
      : [],
  );
  return { kind: "done", skipped: skippedHere };
}

/** The checks that keep `finish` from running. `finish` refuses while this list isn't empty. */
export function finishBlockers(ctx: Context): string[] {
  return openChecks(ctx);
}

/** Whether a step runs against GitHub or Cloudflare, so fixture mode skips it. */
export function isRemoteStep(id: StepId): boolean {
  return (
    ITEMS.some((item) => item.remote === id) || id === "deploy-rerun" || id === "deploy-failed"
  );
}
