// Tests for the whole `finish` flow in a small Git repository that looks like a finished setup:
// a failed local step leaves the setup files in place, a passing one removes them and the setup
// dependency, and a failed deploy after the push reverts the finish commit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { checkDeploy, finish, FINISH_SUBJECT, finishCopyDir } from "../finish.ts";
import { manifestHash, treeFingerprint } from "../probes.ts";
import { fake } from "./fakes.ts";

// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

const PRUNE = path.resolve(import.meta.dirname, "..", "..", "prune.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

const FIXTURE = {
  github: { login: "octocat" },
  wrangler: { accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Acme" }] },
  repository: { description: "" },
  workersSubdomain: "acme",
  apiToken: { saved: true, valid: true },
  githubSecrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  githubVariables: {
    DEPLOY_ENABLED: "true",
    HEALTHCHECK_URL: "https://acme-tools.acme.workers.dev",
  },
  pushed: true,
  deploy: { url: "https://example.com/runs/1", status: "success", attempts: 1, runId: 1 },
  live: [{ name: "healthz", ok: true, detail: "200" }],
};

/**
 * A web-app-only project at the end of setup: every check passes, so `finish` may run. The
 * remote half of the facts comes from a fixture file. Its origin pushes to a local bare repository.
 */
function finishedProject(): { root: string; fixture: string; home: string } {
  const base = mkdtempSync(path.join(tmpdir(), "setup-finish-flow-"));
  const root = path.join(base, "acme-tools");
  const home = path.join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  git(base, "init", "--quiet", "--bare", "remote.git");
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "Setup Test");
  git(root, "config", "user.email", "setup-test@example.com");
  git(root, "remote", "add", "origin", "https://github.com/example/acme-tools.git");
  git(
    root,
    "config",
    `url.${path.join(base, "remote.git")}.insteadOf`,
    "https://github.com/example/acme-tools.git",
  );

  write(
    root,
    "package.json",
    `${JSON.stringify({ name: "acme-tools", devDependencies: { cf: "1.0.0-beta.29", wrangler: "4.0.0" } }, null, 2)}\n`,
  );
  write(
    root,
    "pnpm-workspace.yaml",
    "minimumReleaseAgeExclude:\n  - cf@1.0.0-beta.29\n  - vite@8.3.6\n",
  );
  write(
    root,
    "AGENTS.md",
    "# acme-tools\n\n<!-- setup:begin -->\n\n> Setup isn't finished.\n\n<!-- setup:end -->\n\nHalves present: web app.\n\n## Commands\n\nRun pnpm verify.\n",
  );
  write(root, "src/web/app.ts", "// The web app.\nexport const app = 1;\n");
  write(
    root,
    "wrangler.jsonc",
    "// Wrangler configuration. Blocks between markers belong to a part.\n{}\n",
  );
  write(
    root,
    "renovate.json5",
    "// Renovate configuration. Blocks between markers belong to a part.\n{}\n",
  );
  write(
    root,
    ".github/workflows/ci.yml",
    "# - `setup` runs the setup scenarios.\nname: CI\njobs:\n  setup:\n    runs-on: ubuntu-latest\n  workflows:\n    runs-on: ubuntu-latest\n",
  );
  write(root, ".gitignore", "node_modules/\n\n# Setup state\nsetup.local.json\n");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(PRUNE, path.join(root, "scripts", "prune.ts"));
  write(root, "scripts/setup.ts", "// The setup script.\n");
  write(root, "scripts/setup/planner.ts", "// The planner, which SETUP.md describes.\n");
  write(root, "SETUP.md", "# Set up a project from this template\n");
  write(
    root,
    "setup.json",
    `${JSON.stringify({ answers: { brief: "Tracks support requests for the Acme team. First, build a tool that lists open requests and a page that shows one request.", "display-name": "Acme Tools", description: "", parts: "web", "web-access": "public", hostname: "workers.dev", license: "mit-0" } }, null, 2)}\n`,
  );
  write(root, "node_modules/.modules.yaml", "");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "Set up acme-tools from the template");
  git(root, "push", "--quiet", "origin", "main");
  write(
    root,
    "setup.local.json",
    `${JSON.stringify({ answers: { renovate: "not-now" }, secretHashes: {}, installedFor: manifestHash(root), verifiedFingerprint: treeFingerprint(root), summaryShown: true, fixtureSkipped: "github-secrets" }, null, 2)}\n`,
  );
  const fixture = path.join(base, "fixture.json");
  writeFileSync(fixture, JSON.stringify(FIXTURE));
  return { root, fixture, home };
}

function withHome<T>(home: string, use: () => T): T {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return use();
  } finally {
    process.env.HOME = previous;
  }
}

// Answers `gh` as if the deploy job of the finish commit failed after its rerun.
function failedRun(call: { command: string; args: string[] }) {
  const route = call.args[1] ?? "";
  if (call.command !== "gh") {
    return undefined;
  }
  if (route.includes("/runs?")) {
    return {
      stdout:
        '{"workflow_runs":[{"id":3,"html_url":"https://example.com/runs/3","status":"completed","run_attempt":2}]}',
    };
  }
  return {
    stdout:
      '{"jobs":[{"name":"Deploy to production","status":"completed","conclusion":"failure"}]}',
  };
}

describe("the finish flow", () => {
  test("a failed local step leaves the setup files in place", () => {
    const { root, fixture, home } = finishedProject();
    const local = readFileSync(path.join(root, "setup.local.json"), "utf8");
    const head = git(root, "rev-parse", "HEAD");
    const recorder = fake([
      (call) => (call.command === "pnpm" && call.args[0] === "verify" ? { status: 1 } : undefined),
    ]);
    let code: number;
    try {
      code = withHome(home, () => finish(root, fixture, path.join(root, "scripts")));
    } finally {
      recorder.restore();
    }
    assert.equal(code, 1);
    for (const file of [
      "scripts/setup.ts",
      "scripts/setup/planner.ts",
      "setup.json",
      "scripts/prune.ts",
    ]) {
      assert.ok(existsSync(path.join(root, file)), `${file} is gone`);
    }
    // The state comes back without the install cache, because `finish` installed without cf.
    const restored: unknown = JSON.parse(readFileSync(path.join(root, "setup.local.json"), "utf8"));
    const expected: unknown = JSON.parse(local);
    assert.ok(typeof expected === "object" && expected !== null && "installedFor" in expected);
    const { installedFor: _cache, ...rest } = expected;
    assert.deepEqual(restored, rest);
    assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /setup:begin/);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.ok(recorder.printed.some((line) => line.includes("Putting the setup files back.")));
  });

  test("a finish interrupted before its commit resumes from the copy and puts the files back", () => {
    const { root, home } = finishedProject();
    const copy = withHome(home, () => finishCopyDir({ owner: "example", name: "acme-tools" }));
    // What the interrupted run did before it stopped: the copy, then `prune.ts --finish`.
    write(copy, "state/setup.json", readFileSync(path.join(root, "setup.json"), "utf8"));
    write(
      copy,
      "state/setup.local.json",
      readFileSync(path.join(root, "setup.local.json"), "utf8"),
    );
    execFileSync(process.execPath, ["scripts/prune.ts", "--finish"], {
      cwd: root,
      stdio: "ignore",
    });
    assert.ok(!existsSync(path.join(root, "scripts", "setup.ts")));
    const recorder = fake();
    let code: number;
    try {
      code = withHome(home, () => finish(root, undefined, path.join(copy, "scripts")));
    } finally {
      recorder.restore();
    }
    assert.equal(code, 1, recorder.printed.join("\n"));
    for (const file of ["scripts/setup.ts", "scripts/prune.ts", "setup.json", "setup.local.json"]) {
      assert.ok(existsSync(path.join(root, file)), `${file} didn't come back`);
    }
    assert.ok(!readFileSync(path.join(root, "setup.local.json"), "utf8").includes("installedFor"));
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.ok(!existsSync(copy), "the copy survived");
  });

  test("a passing local run removes the setup files and the setup dependency, and commits", () => {
    const { root, fixture, home } = finishedProject();
    const recorder = fake();
    let code: number;
    try {
      code = withHome(home, () => finish(root, fixture, path.join(root, "scripts")));
    } finally {
      recorder.restore();
    }
    assert.equal(code, 0, recorder.printed.join("\n"));
    for (const file of [
      "scripts/setup.ts",
      "scripts/setup",
      "setup.json",
      "setup.local.json",
      "scripts/prune.ts",
    ]) {
      assert.ok(!existsSync(path.join(root, file)), `${file} survived`);
    }
    assert.ok(!readFileSync(path.join(root, "package.json"), "utf8").includes('"cf"'));
    assert.ok(!readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").includes("cf@"));
    assert.ok(!readFileSync(path.join(root, "AGENTS.md"), "utf8").includes("setup:begin"));
    // The brief moves into AGENTS.md, where a coding agent reads it at the start of work.
    const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(
      agents,
      /\n## What to build\n\nTracks support requests for the Acme team\. First, build a tool/,
    );
    assert.match(agents, /delete this section once it stops helping/);
    assert.ok(recorder.printed.some((line) => line.startsWith("Tracks support requests")));
    assert.ok(!readFileSync(path.join(root, ".gitignore"), "utf8").includes("setup.local.json"));
    assert.equal(git(root, "log", "-1", "--format=%s").trim(), FINISH_SUBJECT);
    // The setup script mentions SETUP.md, but this run deletes both, so there's no notice.
    assert.ok(
      !recorder.printed.some((line) => line.includes("still mentions")),
      recorder.printed.join("\n"),
    );
    assert.deepEqual(
      recorder.calls.map((call) => [call.command, ...call.args].join(" ")),
      ["pnpm install --no-frozen-lockfile", "pnpm verify"],
    );
  });

  test("a failed deploy after the push reverts the finish commit and restores the state", () => {
    const { root, fixture, home } = finishedProject();
    // Run the local part in fixture mode, then push, as the remote part would.
    let recorder = fake();
    try {
      withHome(home, () => finish(root, fixture, path.join(root, "scripts")));
    } finally {
      recorder.restore();
    }
    git(root, "push", "--quiet", "origin", "HEAD:main");
    const copy = withHome(home, () => finishCopyDir({ owner: "example", name: "acme-tools" }));
    write(copy, "state/setup.json", '{"answers":{"parts":"web","hostname":"workers.dev"}}\n');
    write(copy, "state/setup.local.json", '{"answers":{"renovate":"not-now"},"secretHashes":{}}\n');
    recorder = fake([failedRun]);
    let code: number;
    try {
      code = withHome(home, () => checkDeploy(root, copy));
    } finally {
      recorder.restore();
    }
    assert.equal(code, 1, recorder.printed.join("\n"));
    assert.match(
      git(root, "log", "-1", "--format=%s"),
      /^Revert "Remove the template setup files"/,
    );
    assert.ok(
      existsSync(path.join(root, "scripts", "setup.ts")),
      "the setup files didn't come back",
    );
    assert.ok(existsSync(path.join(root, "setup.local.json")), "the state didn't come back");
    assert.ok(
      recorder.calls.some(
        (call) => call.command === "git" && call.args.join(" ") === "push origin HEAD:main",
      ),
      "the revert wasn't pushed",
    );
    assert.ok(!existsSync(copy), "the copy survived a failed finish");
  });
});
