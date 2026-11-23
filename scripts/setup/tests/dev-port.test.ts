// Tests for the project's own dev server port: `devPort()` derives it from the project name, the
// rename step writes it over the template's port, and the GitHub OAuth app task names it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

import { devPort } from "../derive.ts";
import { renameLeftovers } from "../probes.ts";
import { STEPS } from "../steps.ts";
import { task } from "../tasks.ts";
import { fake } from "./fakes.ts";
import { freshContext } from "./world.ts";

const SKIPPED = new Set([5353, 5432, 5500, 5555, 5601, 5672]);

describe("devPort", () => {
  test("stays in the range from 5200 to 5899 and off the skip list", () => {
    for (let index = 0; index < 2000; index += 1) {
      const port = devPort(`project-${String(index)}`);
      assert.ok(port >= 5200 && port <= 5899, `project-${String(index)} got ${String(port)}`);
      assert.ok(!SKIPPED.has(port), `project-${String(index)} got ${String(port)}`);
    }
  });

  test("gives a name the same port every time", () => {
    assert.equal(devPort("acme-tools"), devPort("acme-tools"));
    assert.equal(devPort("acme-tools"), 5437);
  });

  test("gives different names different ports", () => {
    assert.notEqual(devPort("acme-tools"), devPort("cloudflare-starter"));
  });

  test("steps past a port on the skip list to the next one", () => {
    // Each of these names hashes straight to the skipped port one below its result.
    assert.equal(devPort("project-1564"), 5354);
    assert.equal(devPort("project-100"), 5433);
    assert.equal(devPort("project-180"), 5501);
    assert.equal(devPort("project-211"), 5556);
    assert.equal(devPort("project-297"), 5602);
    assert.equal(devPort("project-333"), 5673);
  });
});

describe("the rename step", () => {
  test("replaces each form of the template's port and leaves bare digits alone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "setup-rename-test-"));
    const recorder = fake();
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const port = String(devPort("acme-tools"));
      const files: Record<string, [string, string]> = {
        "vite.config.ts": [
          "server: { port: 5173, strictPort: true },\n",
          `server: { port: ${port}, strictPort: true },\n`,
        ],
        "README.md": [
          "Open http://localhost:5173/healthz. The dev server listens on port 5173.\n",
          `Open http://localhost:${port}/healthz. The dev server listens on port ${port}.\n`,
        ],
        "test/resource.test.ts": [
          'it.each(["http://[::1]:5173"]);\n// Port 5173 is the default.\n',
          `it.each(["http://[::1]:${port}"]);\n// Port ${port} is the default.\n`,
        ],
        "pnpm-lock.yaml": [
          "version: 5173.0.0\nintegrity: sha512-ab5173cd\nexport 5173\nlocalhost:51730\n",
          "version: 5173.0.0\nintegrity: sha512-ab5173cd\nexport 5173\nlocalhost:51730\n",
        ],
      };
      for (const [file, [before]] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), before);
      }
      assert.deepEqual(renameLeftovers(root), [
        "README.md",
        "test/resource.test.ts",
        "vite.config.ts",
      ]);

      const ctx = freshContext();
      ctx.repo.root = root;
      ctx.answers["display-name"] = "Acme Tools";
      STEPS.rename.run(ctx);
      for (const [file, [, after]] of Object.entries(files)) {
        assert.equal(readFileSync(path.join(root, file), "utf8"), after, file);
      }
      assert.deepEqual(renameLeftovers(root), []);
      assert.match(STEPS.rename.title(ctx), new RegExp(`port 5173 with ${port}\\.$`));

      recorder.printed.length = 0;
      STEPS.rename.run(ctx);
      assert.deepEqual(recorder.printed, []);
    } finally {
      recorder.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the GitHub OAuth app task", () => {
  test("names the callback URL on the project's own port", () => {
    const ctx = freshContext();
    ctx.answers.parts = "mcp";
    ctx.answers["sign-in"] = "github";
    const text = task("github-oauth-app").instruction(ctx).join("\n");
    assert.ok(text.includes(`http://localhost:${String(devPort("acme-tools"))}/callback`));
    assert.ok(!text.includes("5173"));
  });
});
