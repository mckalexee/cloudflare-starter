// Tests for `finish`: it refuses while any check is open, both as the rule that the planner
// exposes and as the command run against a real Git repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

import { finish, renderRefusal } from "../finish.ts";
import { finishBlockers, plan } from "../planner.ts";
import { SCENARIOS, walk } from "./world.ts";

describe("finish", () => {
  test("has no blockers exactly when the planner reports done", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      const { ctx } = walk(scenario, {}, (current, action) => {
        assert.equal(finishBlockers(current).length === 0, action.kind === "done");
      });
      assert.equal(plan(ctx).kind, "done");
      assert.deepEqual(finishBlockers(ctx), []);
    }
  });

  test("names every open check when it refuses", () => {
    const { ctx } = walk(SCENARIOS["both bearer public"] ?? {});
    ctx.facts.pushed = false;
    ctx.repo.verified = false;
    const blockers = finishBlockers(ctx);
    assert.deepEqual(blockers, ["step:verify", "step:push"]);
    const lines = renderRefusal(blockers);
    assert.equal(lines[0], "REFUSED: finish");
    assert.ok(lines.includes("- step:verify") && lines.includes("- step:push"));
    assert.match(lines.at(-1) ?? "", /^Next:/);
  });

  test("refuses in a repository with open checks and changes nothing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "setup-finish-test-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init", "--quiet");
      git("remote", "add", "origin", "https://github.com/example/acme-tools.git");
      mkdirSync(path.join(root, "scripts", "setup"), { recursive: true });
      writeFileSync(
        path.join(root, "package.json"),
        '{ "devDependencies": { "wrangler": "4.0.0" } }\n',
      );
      writeFileSync(path.join(root, "AGENTS.md"), "# acme-tools\n");
      writeFileSync(path.join(root, "scripts", "setup.ts"), "// The setup script.\n");
      const fixture = path.join(root, "fixture.json");
      writeFileSync(fixture, "{}\n");
      const before = readdirSync(root).toSorted();

      const log = console.log;
      const printed: string[] = [];
      console.log = (line: string) => printed.push(line);
      let code: number;
      try {
        code = await finish(root, fixture);
      } finally {
        console.log = log;
      }

      assert.equal(code, 1);
      assert.equal(printed[0], "REFUSED: finish");
      assert.ok(printed.includes("- question:display-name"));
      assert.deepEqual(readdirSync(root).toSorted(), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
