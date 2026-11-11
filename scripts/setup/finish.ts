// `node scripts/setup.ts finish`: removes the setup files once every check passes. It's all or
// nothing. It refuses while any check is open. It copies itself and the state files to a folder
// outside the repository first, so it can wait for the deploy and resume from the copy after the
// setup files are gone. If a local step fails, it puts the files back. If the deploy or a live
// check fails after the push, it reverts the commit, never rewriting `main`, and restores the
// state. It deletes the copy only after everything passes.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { read, run, say, StepError } from "./exec.ts";
import { RUN } from "./output.ts";
import { finishBlockers } from "./planner.ts";
import { loadContext, readOrigin } from "./probes.ts";
import { repoSlug } from "./remote.ts";
import { LOCAL_FILE, SHARED_FILE } from "./state.ts";
import type { Context } from "./types.ts";

/** The subject of the commit that removes the setup files. */
export const FINISH_SUBJECT = "Remove the template setup files";

/** The folder outside the repository that holds the copy of the script and its state. */
export function finishCopyDir(origin: { owner: string; name: string }): string {
  return path.join(homedir(), ".config", `setup-${origin.owner}-${origin.name}`, "finish");
}

// Setup is done, but the request isn't: the brief says what to build next.
function buildNext(brief: string | undefined): string[] {
  return [
    "",
    "Brief, now in the What to build section of AGENTS.md:",
    brief ?? "(none recorded)",
    "",
    "Next: build the first things that the brief names, with the checklists in AGENTS.md and pnpm verify, on a branch with a pull request, so the Preview shows the result before it reaches production.",
  ];
}

/** The lines that `finish` prints when a check is still open. */
export function renderRefusal(blockers: string[]): string[] {
  return [
    "REFUSED: finish",
    "Setup can't finish while these checks are open:",
    ...blockers.map((blocker) => `- ${blocker}`),
    "",
    `Next: run \`${RUN}\` until it prints DONE, then run \`${RUN} finish\` again.`,
  ];
}

/**
 * Puts the setup files back after a failed local step: the working tree returns to `HEAD`, the
 * last setup commit, and `setup.local.json` gets its earlier contents. `finish` runs only on a
 * clean tree, so the reset discards nothing but its own changes.
 */
export function restoreSetupFiles(root: string, localState: string | undefined): void {
  run(root, "git", ["reset", "--quiet", "--hard", "HEAD"]);
  if (localState !== undefined) {
    writeFileSync(path.join(root, LOCAL_FILE), withoutInstallCache(localState), { mode: 0o600 });
  }
}

// `finish` ran `pnpm install` without the Cloudflare CLI, so the install cache no longer matches
// `node_modules`, and the next run must install again.
function withoutInstallCache(state: string): string {
  const parsed: unknown = JSON.parse(state);
  if (typeof parsed !== "object" || parsed === null) {
    return state;
  }
  const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "installedFor"));
  return `${JSON.stringify(rest, null, 2)}\n`;
}

const LIVE_ATTEMPTS = 5;
const ATTEMPTS_FILE = "finish-live-attempts";

// Counts the runs that found a failed live check after the finish deploy, in the copy.
function liveAttempts(copy: string, add: number): number {
  const file = path.join(copy, "state", ATTEMPTS_FILE);
  const count = (existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0) + add;
  writeFileSync(file, String(count));
  return count;
}

function copyScript(root: string, scriptDir: string, copy: string): void {
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(path.join(copy, "state"), { recursive: true });
  cpSync(path.join(scriptDir, "setup.ts"), path.join(copy, "scripts", "setup.ts"));
  cpSync(path.join(scriptDir, "setup"), path.join(copy, "scripts", "setup"), { recursive: true });
  for (const file of [SHARED_FILE, LOCAL_FILE]) {
    if (existsSync(path.join(root, file))) {
      cpSync(path.join(root, file), path.join(copy, "state", file));
    }
  }
  say(`Copied the setup script and its state to ${copy}.`);
}

function removeSetupFiles(root: string): void {
  run(root, process.execPath, ["scripts/prune.ts", "--finish"], {
    display: "node scripts/prune.ts --finish",
  });
  // `--finish` drops the Cloudflare CLI from the dependencies, so the lockfile changes.
  run(root, "pnpm", ["install", "--no-frozen-lockfile"]);
  run(root, "pnpm", ["verify"]);
  run(root, "git", ["add", "--all"]);
  const ignored = read(root, "git", [
    "ls-files",
    "--cached",
    "--ignored",
    "--exclude-standard",
  ]).trim();
  if (ignored !== "") {
    throw new StepError(
      `The index holds ignored files that can carry secrets: ${ignored.split("\n").join(", ")}.`,
    );
  }
  run(root, "git", ["commit", "--quiet", "-m", FINISH_SUBJECT]);
}

function resumeCommand(copy: string, root: string): string {
  return `node ${path.join(copy, "scripts", "setup.ts")} --root ${root} finish`;
}

// Restores the setup files after the finish commit was pushed: a revert commit, pushed, and the
// state file from the copy. `main` keeps its history.
function revertFinish(ctx: Context, copy: string, reason: string): number {
  const { root } = ctx.repo;
  say(
    "",
    `Result: finish failed. ${reason}`,
    "Reverting the finish commit to put the setup files back.",
  );
  try {
    run(root, "git", ["revert", "--no-edit", "HEAD"]);
    run(root, "git", ["push", "origin", "HEAD:main"]);
  } catch (error) {
    if (!(error instanceof StepError)) {
      throw error;
    }
    say(`The revert didn't complete: ${error.message} Revert ${FINISH_SUBJECT} by hand.`);
  }
  const state = path.join(copy, "state", LOCAL_FILE);
  if (existsSync(state)) {
    writeFileSync(path.join(root, LOCAL_FILE), withoutInstallCache(readFileSync(state, "utf8")), {
      mode: 0o600,
    });
  }
  rmSync(copy, { recursive: true, force: true });
  say(
    `Next: fix the cause, run \`${RUN}\` until it prints DONE, then run \`${RUN} finish\` again.`,
  );
  return 1;
}

/** Waits on the deploy of the finish commit and its live checks, from the copy's state. */
export function checkDeploy(root: string, copy: string): number {
  const ctx = loadContext(root, { stateRoot: path.join(copy, "state") });
  if (!ctx.facts.pushed) {
    run(root, "git", ["push", "origin", "HEAD:main"]);
    return checkDeploy(root, copy);
  }
  const deploy = ctx.facts.deploy;
  if (deploy === null || deploy.status === "pending") {
    say(
      "WAIT: finish",
      `Setup is waiting on ${deploy?.url ?? `the deploy run for the finish commit in ${repoSlug(ctx)}`}.`,
      `Project folder: ${root}`,
      `Next: run \`${resumeCommand(copy, root)}\` again in about a minute.`,
    );
    return 0;
  }
  if (deploy.status === "failure") {
    if (deploy.attempts < 2 && deploy.conclusion !== "skipped") {
      run(root, "gh", ["run", "rerun", String(deploy.runId), "--failed", "--repo", repoSlug(ctx)]);
      say(
        "WAIT: finish",
        `The deploy job failed once, so the script reran it: ${deploy.url}.`,
        `Next: run \`${resumeCommand(copy, root)}\` again in about a minute.`,
      );
      return 0;
    }
    return revertFinish(
      ctx,
      copy,
      `The deploy job of ${deploy.url} concluded ${deploy.conclusion ?? "failure"}.`,
    );
  }
  const failed = (ctx.facts.live ?? []).filter((check) => !check.ok);
  if (ctx.facts.live === null || failed.length > 0) {
    const detail = failed.map((check) => check.detail).join(" ") || "none ran";
    // A new deploy can take a minute to answer everywhere, so a failed check waits first.
    const attempts = liveAttempts(copy, 1);
    if (attempts < LIVE_ATTEMPTS) {
      say(
        "WAIT: finish",
        `The finish commit deployed in ${deploy.url}, but a live check failed (try ${String(attempts)} of ${String(LIVE_ATTEMPTS)}): ${detail}`,
        `Project folder: ${root}`,
        `Next: run \`${resumeCommand(copy, root)}\` again in about a minute.`,
      );
      return 0;
    }
    return revertFinish(ctx, copy, `Live checks failed ${String(LIVE_ATTEMPTS)} times: ${detail}`);
  }
  rmSync(copy, { recursive: true, force: true });
  rmSync(path.join(root, LOCAL_FILE), { force: true });
  rmSync(ctx.repo.apiTokenFile, { force: true });
  say(
    "",
    "DONE",
    `Setup is finished. The finish commit deployed in ${deploy.url}, and every live check passed.`,
    `The copy of the setup script and the API token file, ${ctx.repo.apiTokenFile}, are deleted. GitHub keeps the token as the CLOUDFLARE_API_TOKEN secret.`,
    ...buildNext(ctx.answers.brief),
  );
  return 0;
}

/** Runs `finish` and returns the exit code. `scriptDir` is the folder that holds `setup.ts`. */
export function finish(root: string, fixtureFile: string | undefined, scriptDir: string): number {
  const copy = finishCopyDir(readOrigin(root));
  if (!existsSync(path.join(root, "scripts", "setup.ts"))) {
    // The setup files are gone, so this is a run from the copy.
    if (!existsSync(path.join(copy, "state"))) {
      say("REFUSED: finish", "The setup files are gone and there's no copy to resume from.");
      return 1;
    }
    if (read(root, "git", ["log", "-1", "--format=%s"]).trim() === FINISH_SUBJECT) {
      return checkDeploy(root, copy);
    }
    // An earlier run stopped after it removed the setup files and before its commit.
    say(
      "FINISH",
      "The last finish stopped before its commit, so this run puts the setup files back.",
      "",
    );
    const state = path.join(copy, "state", LOCAL_FILE);
    restoreSetupFiles(root, existsSync(state) ? readFileSync(state, "utf8") : undefined);
    rmSync(copy, { recursive: true, force: true });
    say(
      "",
      "Result: the setup files and their state are back.",
      `Next: run \`${RUN}\` until it prints DONE, then run \`${RUN} finish\` again.`,
    );
    return 1;
  }
  const ctx = loadContext(root, { fixture: fixtureFile });
  const blockers = finishBlockers(ctx);
  if (blockers.length > 0) {
    for (const line of renderRefusal(blockers)) {
      say(line);
    }
    return 1;
  }
  say("FINISH", "Remove the setup files, verify the result, commit it, and push it.", "");
  if (ctx.fixture) {
    say(
      "Fixture mode doesn't copy the setup script outside the repository, push, or wait for a deploy, so an interrupted run can't resume from a copy.",
    );
  } else {
    copyScript(root, scriptDir, copy);
    say(
      `If this run stops before it prints a result, run \`${resumeCommand(copy, root)}\`. It puts the setup files back, or continues after the commit.`,
      "",
    );
  }
  const localFile = path.join(root, LOCAL_FILE);
  const localState = existsSync(localFile) ? readFileSync(localFile, "utf8") : undefined;
  try {
    removeSetupFiles(root);
  } catch (error) {
    if (!(error instanceof StepError)) {
      throw error;
    }
    say("", `Result: finish failed. ${error.message}`, "Putting the setup files back.");
    restoreSetupFiles(root, localState);
    rmSync(copy, { recursive: true, force: true });
    say(`Next: fix the cause, then run \`${RUN} finish\` again.`);
    return 1;
  }
  if (ctx.fixture) {
    say(
      "",
      "DONE",
      "Setup is finished: the setup files are removed and committed. Fixture mode skipped the push and the deploy checks.",
      ...buildNext(ctx.answers.brief),
    );
    return 0;
  }
  try {
    run(root, "git", ["push", "origin", "HEAD:main"]);
  } catch (error) {
    if (!(error instanceof StepError)) {
      throw error;
    }
    // Nothing reached GitHub, so the local commit can go.
    say("", `Result: finish failed. ${error.message}`, "Putting the setup files back.");
    run(root, "git", ["reset", "--quiet", "--hard", "HEAD~1"]);
    restoreSetupFiles(root, localState);
    rmSync(copy, { recursive: true, force: true });
    return 1;
  }
  return checkDeploy(root, copy);
}
