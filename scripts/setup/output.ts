// Formats what a run prints. A coding agent reads the output and relays parts of it to a person,
// so every action has the same shape: a first line that names the kind of action and its key,
// the body, and a last line that starts with "Next:" and says what the agent does after it.
import { hasMcp, host, signIn } from "./derive.ts";
import { question } from "./questions.ts";
import { STEPS } from "./steps.ts";
import { task } from "./tasks.ts";
import type { Action, Context, StepId } from "./types.ts";

/** The command that runs the next action. */
export const RUN = "node scripts/setup.ts";

function resume(ctx: Context): string[] {
  return [
    `Project folder: ${ctx.repo.root}`,
    `To resume in a new session, tell the agent: "Continue the setup in ${ctx.repo.root}. Run \`${RUN}\` and follow what it prints."`,
  ];
}

/** The lines for a question. */
export function renderQuestion(
  ctx: Context,
  action: Extract<Action, { kind: "question" }>,
): string[] {
  const spec = question(action.key);
  const lines = [`QUESTION: ${action.key}`];
  lines.push(
    "Ask the person this question, and nothing else in the same message. If you have a structured question tool, use it.",
    "",
  );
  if (action.problem !== undefined) {
    lines.push(
      `The recorded answer, ${ctx.answers[action.key] ?? ""}, doesn't work: ${action.problem}`,
      "",
    );
  }
  lines.push(spec.prompt, ...spec.help(ctx));
  const options = spec.options(ctx);
  if (options === undefined) {
    lines.push("", `Answer format: ${spec.format}`);
  } else {
    lines.push("", "Options:", ...options.map((option) => `- ${option.value}: ${option.label}`));
  }
  const suggestion = spec.suggest(ctx);
  lines.push(
    "",
    suggestion === undefined
      ? "Suggested answer: none. The script found nothing to suggest."
      : `Suggested answer: ${suggestion.value}. ${suggestion.reason}`,
    "",
    `Next: record the answer with \`${RUN} answer ${action.key} <value>\`, quoting a value that has spaces, then run \`${RUN}\` again.`,
  );
  return lines;
}

/** The lines for a person task. */
export function renderTask(ctx: Context, action: Extract<Action, { kind: "task" }>): string[] {
  const spec = task(action.id);
  const others = action.remaining - 1;
  const lines = [
    `TASK: ${action.id}`,
    `Setup is not finished. Waiting on: ${spec.title}`,
    others === 0
      ? "This is the last person task in this block."
      : `Person tasks left in this block: ${String(action.remaining)}, this one included.`,
    "",
    "Relay this instruction to the person:",
    ...spec.instruction(ctx),
    `Link: ${spec.link(ctx)}`,
    "",
    `How the script sees that it's done: ${spec.detection(ctx)}`,
    "",
    ...resume(ctx),
    "",
  ];
  if (spec.answerKey === undefined) {
    lines.push(`Next: wait until the person says it's done, then run \`${RUN}\` again.`);
  } else {
    const values = spec.answerKey === "mcp-client" ? "done|not-now|failed" : "done|not-now";
    lines.push(
      `Next: record the person's answer with \`${RUN} answer ${spec.answerKey} <${values}>\`, then run \`${RUN}\` again. Not now is an accepted answer.`,
    );
  }
  return lines;
}

/** The first lines of a step, printed before it runs. */
export function renderStepStart(ctx: Context, id: StepId): string[] {
  return [`STEP: ${id}`, STEPS[id].title(ctx), ""];
}

/** The lines after a step that finished. */
export function renderStepDone(): string[] {
  return ["", "Result: the step finished."];
}

/** The lines after a step that failed. */
export function renderStepFailed(ctx: Context, message: string): string[] {
  return [
    "",
    `Result: the step failed. ${message}`,
    "Setup is not finished.",
    ...resume(ctx),
    `Next: fix the cause, then run \`${RUN}\` again. If only the person can fix it, relay this result and wait for them.`,
  ];
}

/** The lines for a remote step that fixture mode skipped. */
export function renderSkipped(ctx: Context, id: StepId): string[] {
  return [
    `STEP: ${id}`,
    STEPS[id].title(ctx),
    "",
    "Result: skipped, because fixture mode turns off every remote step.",
  ];
}

/** The lines for a wait. */
export function renderWait(ctx: Context, action: Extract<Action, { kind: "wait" }>): string[] {
  return [
    `WAIT: ${action.id}`,
    `Setup is waiting on ${action.url ?? "the deploy workflow run for HEAD, which hasn't started yet"}.`,
    ...resume(ctx),
    `Next: run \`${RUN}\` again in about a minute.`,
  ];
}

function closing(ctx: Context, key: "mcp-client" | "renovate", label: string): string {
  const answer = ctx.local.answers[key];
  if (answer === "done") {
    return `- ${label}: done.`;
  }
  return `- ${label}: not now. To do it later: ${task(key).instruction(ctx).join(" ")} (${task(key).link(ctx)})`;
}

/** The lines for done, with a report built from what the script read back. */
export function renderDone(ctx: Context, action: Extract<Action, { kind: "done" }>): string[] {
  const { owner, name } = ctx.repo.origin;
  const hostname = host(ctx);
  const { facts } = ctx;
  const lines = ["DONE"];
  lines.push(
    action.skipped.length === 0
      ? "Setup is finished. Every check passed."
      : "Setup is done except for the remote steps, which fixture mode turned off:",
    ...action.skipped.map((id) => `- ${id}: ${STEPS[id].title(ctx)}`),
    "",
    "Report:",
    `- Repository: https://github.com/${owner}/${name}`,
    `- Parts: ${ctx.answers.parts ?? ""}` +
      (signIn(ctx.answers) === undefined ? "" : `, MCP sign-in: ${signIn(ctx.answers) ?? ""}`) +
      (ctx.answers["web-access"] === undefined || !(ctx.answers.parts ?? "").includes("web")
        ? ""
        : `, web app: ${ctx.answers["web-access"]}`),
    `- Hostname: https://${hostname ?? "<host>"}` +
      (hasMcp(ctx.answers) ? `, MCP URL: https://${hostname ?? "<host>"}/mcp` : ""),
  );
  if (hasMcp(ctx.answers)) {
    lines.push(
      `- KV namespaces: ${facts.kvNamespaces.production ?? "none"} for production, ${facts.kvNamespaces.preview ?? "none"} for Previews`,
    );
  }
  if (facts.accessApps.allow !== null) {
    lines.push(`- Access application AUD: ${facts.accessApps.allow.aud}`);
  }
  if (facts.deploy !== null) {
    lines.push(`- Deploy run: ${facts.deploy.url}, ${facts.deploy.status}`);
  }
  for (const check of facts.live ?? []) {
    lines.push(`- Live check ${check.name}: ${check.ok ? "passed" : "failed"}. ${check.detail}`);
  }
  if (hasMcp(ctx.answers)) {
    lines.push(closing(ctx, "mcp-client", "MCP client"));
  }
  lines.push(closing(ctx, "renovate", "Renovate"));
  lines.push(`- License: ${ctx.answers.license ?? "mit-0"}`);
  lines.push("", `Next: run \`${RUN} finish\` to remove the setup files.`);
  return lines;
}
