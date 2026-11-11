// Tests for a plain run: it runs the due steps in a row, runs a step again when a later step
// reopened its check, and stops only when a step comes right back after it ran.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runDueSteps } from "../loop.ts";
import type { Context, StepId } from "../types.ts";
import { fake } from "./fakes.ts";
import { doStep, SCENARIOS, walk } from "./world.ts";

// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

// A finished bearer-mode run, put back to the point after the config step: the tree is changed
// and unverified, and the Worker doesn't exist yet.
function beforeVerify(): Context {
  const { ctx } = walk(SCENARIOS["mcp bearer"] ?? {});
  ctx.repo.verified = false;
  ctx.repo.clean = false;
  ctx.facts.workerSecrets = null;
  ctx.facts.worker = null;
  delete ctx.resources.worker;
  delete ctx.local.secretHashes.production;
  ctx.facts.pushed = false;
  ctx.facts.deploy = null;
  ctx.facts.live = null;
  return ctx;
}

describe("a plain run", () => {
  test("runs verify again after a later step records an ID in setup.json", () => {
    const ctx = beforeVerify();
    const ran: StepId[] = [];
    const recorder = fake();
    let code: number;
    try {
      code = runDueSteps(ctx.repo.root, {
        load: () => ctx,
        runStep: (current, id) => {
          ran.push(id);
          // The worker-secrets step records the Worker's ID in setup.json, which changes the tree.
          doStep(current, id);
        },
      });
    } finally {
      recorder.restore();
    }
    assert.equal(code, 0, recorder.printed.join("\n"));
    assert.deepEqual(ran.slice(0, 5), ["verify", "commit", "worker-secrets", "verify", "commit"]);
    assert.ok(!recorder.printed.some((line) => line.includes("check is still open")));
  });

  test("stops when a step's check stays open right after it ran", () => {
    const ctx = beforeVerify();
    const recorder = fake();
    let code: number;
    try {
      // A verify step that never records its result.
      code = runDueSteps(ctx.repo.root, { load: () => ctx, runStep: () => undefined });
    } finally {
      recorder.restore();
    }
    assert.equal(code, 1);
    assert.ok(recorder.printed.some((line) => line.includes("check is still open")));
  });
});
