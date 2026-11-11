// A plain run of the script: it runs the work steps that are due, one after another, and stops at
// the first thing that needs the agent or the person. Each step changes the repository or the
// accounts, so the facts are read again after each one. A later step can reopen an earlier
// step's check, such as recording a resource ID in `setup.json` after `pnpm verify` passed, so
// that step runs again. Only a step that comes right back after it ran means it can't close.
import { say, StepError } from "./exec.ts";
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
} from "./output.ts";
import { plan } from "./planner.ts";
import { loadContext } from "./probes.ts";
import { updateLocal } from "./state.ts";
import { STEPS } from "./steps.ts";
import type { Context, StepId } from "./types.ts";

// A run never runs more steps than this, so steps that keep reopening each other can't loop
// forever.
const MAX_STEPS = 40;

/** What a run reads and does, so tests can drive it with a pretend world. */
export type LoopOptions = {
  fixture?: string;
  load?: (root: string) => Context;
  runStep?: (ctx: Context, id: StepId) => void;
};

function print(lines: string[]): void {
  for (const line of lines) {
    say(line);
  }
}

/** Runs the due steps and prints what comes next. Returns the exit code. */
export function runDueSteps(root: string, options: LoopOptions = {}): number {
  const load = options.load ?? ((dir: string) => loadContext(dir, { fixture: options.fixture }));
  const runStep = options.runStep ?? ((ctx: Context, id: StepId) => STEPS[id].run(ctx));
  let previous: StepId | undefined;
  for (let count = 0; count < MAX_STEPS; count++) {
    const ctx = load(root);
    const action = plan(ctx);
    if (action.kind !== "step") {
      if (previous !== undefined) {
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
    if (action.id === previous) {
      print([
        ...renderStepStart(ctx, action.id),
        ...renderStepFailed(
          ctx,
          "The step ran, but its check is still open, so the script stopped.",
        ),
      ]);
      return 1;
    }
    if (previous !== undefined) {
      say("");
    }
    previous = action.id;
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
      runStep(ctx, action.id);
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
