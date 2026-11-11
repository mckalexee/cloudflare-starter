// Sets up a project created from this template. A coding agent runs it in a loop. Each run runs
// the work steps that are due, one after another, and stops at the first thing that needs the
// agent or the person: a question, a task for the person, a wait, a failure, or done. The modules
// in `scripts/setup/` hold the questions, the planner, the probes, the steps, and the state. It
// runs before `pnpm install`, so it uses only Node built-ins.
//
//   node scripts/setup.ts                       Run the due steps, then print what comes next.
//   node scripts/setup.ts answer <key> <value>  Record an answer.
//   node scripts/setup.ts finish                Remove the setup files once every check passes.
//
// `--root <dir>` names the project folder, for a copy of the script that `finish` runs from
// outside the repository. `SETUP_FIXTURE=<file>` replaces every remote probe with the facts in
// that file and turns off every remote step, so CI can run the local half without accounts.
import path from "node:path";

import { conflicts } from "./setup/derive.ts";
import { ProbeError, say, StepError } from "./setup/exec.ts";
import { finish } from "./setup/finish.ts";
import {
  renderDone,
  renderQuestion,
  renderSkipped,
  renderStepDone,
  renderStepFailed,
  renderStepStart,
  renderTask,
  renderWait,
  RUN,
} from "./setup/output.ts";
import { plan } from "./setup/planner.ts";
import { loadContext, RefusalError } from "./setup/probes.ts";
import { checkAnswer, precheckAnswer } from "./setup/questions.ts";
import { recordResources, readShared, updateLocal, writeShared } from "./setup/state.ts";
import { STEPS } from "./setup/steps.ts";

const FIXTURE =
  process.env.SETUP_FIXTURE === undefined || process.env.SETUP_FIXTURE === ""
    ? undefined
    : path.resolve(process.env.SETUP_FIXTURE);

// A run never runs more steps than this, so a step whose check never closes can't loop forever.
const MAX_STEPS = 40;

function print(lines: string[]): void {
  for (const line of lines) {
    say(line);
  }
}

function next(root: string): number {
  const ran: string[] = [];
  for (let count = 0; count < MAX_STEPS; count++) {
    // Each step changes the repository or the accounts, so the facts are read again.
    const ctx = loadContext(root, { fixture: FIXTURE });
    const action = plan(ctx);
    if (action.kind !== "step") {
      if (ran.length > 0) {
        say("");
      }
      switch (action.kind) {
        case "question":
          print(renderQuestion(ctx, action));
          break;
        case "task":
          print(renderTask(ctx, action));
          break;
        case "wait":
          print(renderWait(ctx, action));
          break;
        case "done":
          print(renderDone(ctx, action));
          break;
      }
      return 0;
    }
    if (ran.includes(action.id) && action.id !== "summary") {
      print([
        ...renderStepStart(ctx, action.id),
        ...renderStepFailed(
          ctx,
          "The step ran, but its check is still open, so the script stopped.",
        ),
      ]);
      return 1;
    }
    ran.push(action.id);
    if (ran.length > 1) {
      say("");
    }
    if (ctx.fixture && action.remote) {
      if (action.id === "deploy-rerun" || action.id === "deploy-failed") {
        print([
          ...renderStepStart(ctx, action.id),
          ...renderStepFailed(ctx, "The fixture's deploy fact says the deploy failed."),
        ]);
        return 1;
      }
      updateLocal(root, (state) => {
        state.fixtureSkipped = [...(state.fixtureSkipped ?? "").split(","), action.id]
          .filter((step) => step !== "")
          .join(",");
      });
      print(renderSkipped(ctx, action.id));
      continue;
    }
    print(renderStepStart(ctx, action.id));
    try {
      STEPS[action.id].run(ctx);
    } catch (error) {
      if (error instanceof StepError) {
        print(renderStepFailed(ctx, error.message));
        return 1;
      }
      throw error;
    }
    print(renderStepDone());
    if (action.id === "summary") {
      // The summary ends the run, so the agent relays it before anything changes in GitHub or
      // Cloudflare.
      say(
        "",
        `Next: relay this summary to the person, then run \`${RUN}\` again to start the changes.`,
      );
      return 0;
    }
  }
  say("", `Result: the script ran ${String(MAX_STEPS)} steps. Next: run \`${RUN}\` again.`);
  return 0;
}

function refuseAnswer(key: string, reason: string): number {
  print([`REFUSED: answer ${key}`, reason, "", `Next: run \`${RUN}\` to see what it asks for.`]);
  return 1;
}

function answer(root: string, key: string, value: string): number {
  // A wrong key or value needs no probes, so it gets its answer before the slow part.
  const pre = precheckAnswer(key, value);
  if (!pre.ok) {
    return refuseAnswer(key, pre.reason);
  }
  const ctx = loadContext(root, { fixture: FIXTURE });
  const check = checkAnswer(key, value, ctx);
  if (!check.ok) {
    return refuseAnswer(key, check.reason);
  }
  if (check.key === "existing-resources" && check.value === "earlier-attempt") {
    // The person vouched for the resources, so their IDs become this project's.
    const found = conflicts(ctx);
    recordResources(root, Object.fromEntries(found.map((conflict) => [conflict.key, conflict.id])));
    print([
      `ANSWERED: ${check.key}`,
      `Recorded ${found.map((conflict) => `${conflict.label} (${conflict.id})`).join(", ")} in setup.json as this project's.`,
      "",
      `Next: run \`${RUN}\` again.`,
    ]);
    return 0;
  }
  if (check.store === "shared") {
    writeShared(root, { ...readShared(root), [check.key]: check.value });
  } else {
    updateLocal(root, (state) => {
      state.answers[check.key] = check.value;
    });
  }
  const where = check.store === "shared" ? "setup.json" : "setup.local.json, which Git ignores";
  print([
    `ANSWERED: ${check.key}`,
    `Recorded ${check.key} as ${check.value === "" ? "empty" : check.value} in ${where}.`,
    "",
    `Next: run \`${RUN}\` again.`,
  ]);
  return 0;
}

function usage(): number {
  print([
    "Usage: node scripts/setup.ts [--root <dir>]",
    "       node scripts/setup.ts [--root <dir>] answer <key> <value>",
    "       node scripts/setup.ts [--root <dir>] finish",
    "",
    "Each run runs the due steps and prints what comes next. SETUP_FIXTURE=<file> replaces the",
    "remote probes with the facts in the file and skips the remote steps.",
  ]);
  return 2;
}

function main(argv: string[]): number {
  const args = [...argv];
  let root = path.resolve(import.meta.dirname, "..");
  const at = args.indexOf("--root");
  if (at !== -1) {
    const dir = args[at + 1];
    if (dir === undefined) {
      return usage();
    }
    root = path.resolve(dir);
    args.splice(at, 2);
  }
  const [command, ...rest] = args;
  try {
    if (command === undefined) {
      return next(root);
    }
    if (command === "answer" && rest.length === 2) {
      return answer(root, rest[0] ?? "", rest[1] ?? "");
    }
    if (command === "finish" && rest.length === 0) {
      return finish(root, FIXTURE, path.resolve(import.meta.dirname));
    }
    return usage();
  } catch (error) {
    if (error instanceof RefusalError) {
      print([`REFUSED: ${command ?? "setup"}`, error.message]);
      return 1;
    }
    if (error instanceof ProbeError) {
      print([
        `FAILED: ${command ?? "setup"}`,
        `A check of GitHub or Cloudflare failed, so the script stopped instead of guessing. ${error.message}`,
        "",
        `Next: fix the cause, such as a missing login or a network problem, then run \`${RUN}\` again.`,
      ]);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
