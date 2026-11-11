// `node scripts/setup.ts finish`: removes the setup files once every check passes. It's all or
// nothing. It refuses while any check is open, and when a local step fails, it puts the setup
// files back, so the project keeps saying that it's unfinished. The remote part, which pushes the
// result and waits for its deploy, belongs to the remote half of setup.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { read, run, say, StepError } from "./exec.ts";
import { RUN } from "./output.ts";
import { finishBlockers } from "./planner.ts";
import { loadContext } from "./probes.ts";
import { LOCAL_FILE } from "./state.ts";
import type { Context } from "./types.ts";

/** The subject of the commit that removes the setup files. */
export const FINISH_SUBJECT = "Remove the template setup files";

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
    writeFileSync(path.join(root, LOCAL_FILE), localState, { mode: 0o600 });
  }
}

function removeSetupFiles(ctx: Context): void {
  const { root } = ctx.repo;
  run(root, process.execPath, ["scripts/prune.ts", "--finish"], {
    display: "node scripts/prune.ts --finish",
  });
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

/** Runs `finish` and returns the exit code. */
export async function finish(root: string, fixtureFile: string | undefined): Promise<number> {
  const ctx = await loadContext(root, fixtureFile);
  const blockers = finishBlockers(ctx);
  if (blockers.length > 0) {
    for (const line of renderRefusal(blockers)) {
      say(line);
    }
    return 1;
  }

  // Remote half, part 1: copy this script and `setup.local.json` to a folder outside the
  // repository before anything changes, so a wait or a failure later in `finish` can resume or
  // restore from the copy after the setup files are gone from the tree.

  const localFile = path.join(root, LOCAL_FILE);
  const localState = existsSync(localFile) ? readFileSync(localFile, "utf8") : undefined;
  say("FINISH", "Remove the setup files, verify the result, and commit it.", "");
  try {
    removeSetupFiles(ctx);
  } catch (error) {
    if (!(error instanceof StepError)) {
      throw error;
    }
    say("", `Result: finish failed. ${error.message}`, "Putting the setup files back.");
    restoreSetupFiles(root, localState);
    say(`Next: fix the cause, then run \`${RUN} finish\` again.`);
    return 1;
  }

  // Remote half, part 2: push the commit, then wait for the deploy job of `HEAD` and the live
  // checks. A long wait returns as "waiting on <run URL>" with a resume command that runs from
  // the copy. If the deploy or a live check fails, restore the setup files with `git revert` of
  // the finish commit, never by rewriting `main`, push that, and exit nonzero. Delete the copy
  // only after everything passes.
  if (!ctx.fixture) {
    say(
      "",
      "Result: the setup files are removed and committed locally. Pushing and checking the deploy belong to the remote half of the setup script, which isn't built yet.",
    );
    return 1;
  }

  say(
    "",
    "Result: the setup files are removed and committed. Fixture mode skips the push and the deploy checks.",
    "Next: nothing. Setup is finished.",
  );
  return 0;
}
