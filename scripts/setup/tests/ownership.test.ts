// Tests for the rules that keep setup from touching what isn't its own, and from leaving the
// person stuck: resources with the project's name, a locked hostname, the origin URL, fixture
// mode, the fresh-clone task texts, and the bearer client command.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { conflicts } from "../derive.ts";
import { plan } from "../planner.ts";
import { loadContext, readOrigin, RefusalError } from "../probes.ts";
import { checkAnswer } from "../questions.ts";
import { task } from "../tasks.ts";
import { contextWithFiles } from "./fakes.ts";
import { SCENARIOS, walk } from "./world.ts";

// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

function repoWithOrigin(url: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "setup-origin-test-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", url], { cwd: root });
  writeFileSync(path.join(root, "package.json"), "{}\n");
  return root;
}

describe("resources with the project's name", () => {
  test("a KV namespace that setup didn't record asks the person before anything uses it", () => {
    const { ctx } = walk(SCENARIOS["mcp bearer"] ?? {});
    ctx.resources = {};
    ctx.facts.repoDeployed = false;
    assert.deepEqual(
      conflicts(ctx).map((conflict) => conflict.key),
      ["kvProduction", "kvPreview", "worker"],
    );
    assert.deepEqual(plan(ctx), {
      kind: "question",
      key: "existing-resources",
      problem: undefined,
    });
  });

  test("the answer something-else leads to a new name, never to the resources", () => {
    const { ctx } = walk(SCENARIOS["mcp bearer"] ?? {});
    ctx.resources = {};
    ctx.answers["existing-resources"] = "something-else";
    const action = plan(ctx);
    assert.equal(action.kind === "task" ? action.id : action.kind, "new-name");
  });

  test("a Worker that this repository deployed is its own, so a fresh clone isn't asked", () => {
    const { ctx } = walk(SCENARIOS["web public"] ?? {});
    ctx.resources = {};
    ctx.facts.repoDeployed = true;
    assert.deepEqual(conflicts(ctx), []);
    ctx.facts.repoDeployed = false;
    assert.equal(conflicts(ctx)[0]?.key, "worker");
  });

  test("recorded IDs from setup.json satisfy the rule", () => {
    const { ctx } = walk(SCENARIOS["mcp github"] ?? {});
    assert.deepEqual(conflicts(ctx), []);
    assert.equal(plan(ctx).kind, "done");
  });
});

describe("answers that would leave no way forward", () => {
  test("web-access can't turn private once workers.dev is locked with GitHub or bearer sign-in", () => {
    for (const mode of ["github", "bearer"]) {
      const ctx = contextWithFiles({
        parts: "mcp,web",
        "sign-in": mode,
        "web-access": "public",
        hostname: "workers.dev",
      });
      ctx.facts.githubVariables.HEALTHCHECK_URL = "https://acme-tools.acme.workers.dev";
      const result = checkAnswer("web-access", "private", ctx);
      assert.ok(!result.ok && /custom domain/.test(result.reason), mode);
    }
    const access = contextWithFiles({
      parts: "mcp,web",
      "sign-in": "access",
      "web-access": "public",
      hostname: "workers.dev",
    });
    access.facts.githubVariables.HEALTHCHECK_URL = "https://acme-tools.acme.workers.dev";
    assert.ok(checkAnswer("web-access", "private", access).ok);
  });
});

describe("the origin and fixture mode", () => {
  test("only github.com origins count, in HTTPS and SSH forms", () => {
    for (const url of [
      "https://github.com/acme/tools.git",
      "git@github.com:acme/tools.git",
      "ssh://git@github.com/acme/tools",
    ]) {
      assert.deepEqual(readOrigin(repoWithOrigin(url)), { owner: "acme", name: "tools" }, url);
    }
    for (const url of [
      "https://mygithub.com/acme/tools.git",
      "https://github.com.evil.example/acme/tools",
    ]) {
      assert.throws(() => readOrigin(repoWithOrigin(url)), RefusalError, url);
    }
  });

  test("fixture mode refuses a project whose origin isn't a scratch value", () => {
    const fixture = path.join(
      mkdtempSync(path.join(tmpdir(), "setup-fixture-test-")),
      "fixture.json",
    );
    writeFileSync(fixture, "{}\n");
    assert.throws(
      () => loadContext(repoWithOrigin("https://github.com/acme/tools.git"), { fixture }),
      (error) => error instanceof RefusalError && /scratch copy/.test(error.message),
    );
    assert.doesNotThrow(() =>
      loadContext(repoWithOrigin("https://github.com/example/tools.git"), { fixture }),
    );
  });
});

describe("tasks after a fresh clone", () => {
  test("an existing OAuth app gets a new secret instead of a second app", () => {
    const ctx = contextWithFiles({ parts: "mcp", "sign-in": "github", hostname: "workers.dev" });
    ctx.facts.workerSecrets = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "COOKIE_SECRET"];
    const text = task("github-oauth-app").instruction(ctx).join(" ");
    assert.match(text, /don't register another one/);
    assert.match(text, /Generate a new client secret/);
  });

  test("a new API token says that it replaces the old one", () => {
    const ctx = contextWithFiles({ parts: "web", hostname: "workers.dev" });
    ctx.facts.githubSecrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
    assert.match(task("cloudflare-api-token").instruction(ctx).join(" "), /replaces the old one/);
  });
});

describe("the bearer client command", () => {
  test("reads the token from .dev.vars when Claude Code connects, and never shows it", () => {
    const secret = "bearer-token-that-must-not-show";
    const ctx = contextWithFiles(
      { parts: "mcp", "sign-in": "bearer", hostname: "workers.dev" },
      { MCP_BEARER_TOKEN: secret },
    );
    const text = task("mcp-client").instruction(ctx).join(" ");
    assert.ok(!text.includes(secret));
    const json = /claude mcp add-json acme-tools '([^']+)'/.exec(text)?.[1] ?? "";
    const server: unknown = JSON.parse(json);
    assert.ok(typeof server === "object" && server !== null && "headersHelper" in server);
    assert.equal(typeof server.headersHelper, "string");
    // Run the helper the way Claude Code does, in a shell, and check the header it prints.
    const output = spawnSync("sh", ["-c", String(server.headersHelper)], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(output.stdout), { Authorization: `Bearer ${secret}` });
  });
});
