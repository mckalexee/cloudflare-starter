// Sets up a project created from this template. A coding agent runs it in a loop, and each run
// prints one thing: a question for the person, a task for the person, work that the script does
// itself, a wait, or done. The modules in `scripts/setup/` hold the questions, the planner, the
// probes, the steps, and the state. It runs before `pnpm install`, so it uses only Node built-ins.
//
//   node scripts/setup.ts                       Print or do the next thing.
//   node scripts/setup.ts answer <key> <value>  Record an answer.
//   node scripts/setup.ts finish                Remove the setup files once every check passes.
//
// `SETUP_FIXTURE=<file>` replaces every remote probe with the facts in that file and turns off
// every remote step, so CI can run the local half without accounts.
import path from "node:path";

import { NotBuiltError, say, StepError } from "./setup/exec.ts";
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
import { readShared, updateLocal, writeShared } from "./setup/state.ts";
import { STEPS } from "./setup/steps.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE =
  process.env.SETUP_FIXTURE === undefined || process.env.SETUP_FIXTURE === ""
    ? undefined
    : path.resolve(process.env.SETUP_FIXTURE);

function print(lines: string[]): void {
  for (const line of lines) {
    say(line);
  }
}

async function next(): Promise<number> {
  const ctx = await loadContext(ROOT, FIXTURE);
  const action = plan(ctx);
  switch (action.kind) {
    case "question":
      print(renderQuestion(ctx, action));
      return 0;
    case "task":
      print(renderTask(ctx, action));
      return 0;
    case "wait":
      print(renderWait(ctx, action));
      return 0;
    case "done":
      print(renderDone(ctx, action));
      return 0;
    case "step":
      break;
  }
  if (ctx.fixture && action.remote) {
    if (action.id === "deploy-rerun" || action.id === "deploy-failed") {
      print([
        ...renderStepStart(ctx, action.id),
        ...renderStepFailed(ctx, "The fixture's deploy fact says the deploy failed."),
      ]);
      return 1;
    }
    updateLocal(ROOT, (state) => {
      state.fixtureSkipped = [...(state.fixtureSkipped ?? "").split(","), action.id]
        .filter((step) => step !== "")
        .join(",");
    });
    print(renderSkipped(ctx, action.id));
    return 0;
  }
  print(renderStepStart(ctx, action.id));
  try {
    await STEPS[action.id].run(ctx);
  } catch (error) {
    if (error instanceof StepError) {
      print(renderStepFailed(ctx, error.message));
      return 1;
    }
    throw error;
  }
  print(renderStepDone());
  return 0;
}

function refuseAnswer(key: string, reason: string): number {
  print([`REFUSED: answer ${key}`, reason, "", `Next: run \`${RUN}\` to see what it asks for.`]);
  return 1;
}

async function answer(key: string, value: string): Promise<number> {
  // A wrong key or value needs no probes, so it gets its answer before the slow part.
  const pre = precheckAnswer(key, value);
  if (!pre.ok) {
    return refuseAnswer(key, pre.reason);
  }
  const ctx = await loadContext(ROOT, FIXTURE);
  const check = checkAnswer(key, value, ctx);
  if (!check.ok) {
    return refuseAnswer(key, check.reason);
  }
  if (check.store === "shared") {
    writeShared(ROOT, { ...readShared(ROOT), [check.key]: check.value });
  } else {
    updateLocal(ROOT, (state) => {
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
    "Usage: node scripts/setup.ts",
    "       node scripts/setup.ts answer <key> <value>",
    "       node scripts/setup.ts finish",
    "",
    "Each run prints one thing to do next. SETUP_FIXTURE=<file> replaces the remote probes with",
    "the facts in the file and skips the remote steps.",
  ]);
  return 2;
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === undefined) {
      return await next();
    }
    if (command === "answer" && rest.length === 2) {
      return await answer(rest[0] ?? "", rest[1] ?? "");
    }
    if (command === "finish" && rest.length === 0) {
      return await finish(ROOT, FIXTURE);
    }
    return usage();
  } catch (error) {
    if (error instanceof RefusalError || error instanceof NotBuiltError) {
      print([`REFUSED: ${command ?? "setup"}`, error.message]);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
