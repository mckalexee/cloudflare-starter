// Tests for the planner: every scenario walks from a fresh clone to done, done comes only when no
// check is open, and person tasks and the summary come before the script's first change.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

import { accessUsed, hasMcp, signIn } from "../derive.ts";
import { openChecks, plan } from "../planner.ts";
import { TASKS } from "../tasks.ts";
import type { Context } from "../types.ts";
import { SCENARIOS, SHARED_ANSWERS, walk, type WorldOptions } from "./world.ts";

const WORLDS: Record<string, WorldOptions> = {
  "a ready account": { accounts: 1, subdomain: true, zeroTrust: "with-pin" },
  "a new account": { accounts: 1, subdomain: false, zeroTrust: "none" },
  "two accounts and a Cloudflare-only login": {
    accounts: 2,
    subdomain: true,
    zeroTrust: "cloudflare-only",
  },
};

/** A context where the planner returned done, for a scenario in a ready account. */
function doneContext(scenario: Record<string, string>): Context {
  return walk(scenario, WORLDS["a ready account"]).ctx;
}

function assertEvidence(ctx: Context): void {
  assert.equal(ctx.facts.deploy?.status, "success", "the deploy job for HEAD succeeded");
  assert.ok(
    ctx.facts.live?.every((check) => check.ok),
    "every live check passed",
  );
  assert.ok(ctx.facts.pushed, "HEAD is pushed");
  assert.ok(ctx.repo.clean, "the working tree is clean");
  assert.ok(ctx.repo.verified, "pnpm verify passed on the tree");
  assert.equal(ctx.repo.configPending.length, 0, "the config edits are applied");
}

describe("a whole run", () => {
  for (const [scenarioName, scenario] of Object.entries(SCENARIOS)) {
    for (const [worldName, world] of Object.entries(WORLDS)) {
      test(`${scenarioName} in ${worldName} reaches done only when no check is open`, () => {
        const result = walk(scenario, world, (ctx, action) => {
          assert.equal(action.kind === "done", openChecks(ctx).length === 0);
        });
        assertEvidence(result.ctx);
        assert.deepEqual(result.actions.at(-1), { kind: "done", skipped: [] });
      });
    }
  }
});

describe("the order of a run", () => {
  for (const [scenarioName, scenario] of Object.entries(SCENARIOS)) {
    test(`${scenarioName}: the person's tasks and the summary come before the first change`, () => {
      const { actions } = walk(scenario, WORLDS["a new account"]);
      const firstChange = actions.findIndex(
        (action) => action.kind === "step" && action.id !== "summary",
      );
      const summary = actions.findIndex(
        (action) => action.kind === "step" && action.id === "summary",
      );
      assert.ok(summary !== -1 && summary < firstChange);
      const firstBlock = new Set(
        TASKS.filter((spec) => spec.block === "first").map((spec) => spec.id),
      );
      // The Cloudflare CLI comes with the install, so its login, the Zero Trust organization,
      // and the one-time PIN question come after the install and before any remote step.
      const afterInstall = new Set(["login-cf", "zero-trust-org", "access-otp"]);
      const installed = actions.findIndex(
        (action) => action.kind === "step" && action.id === "install",
      );
      const firstRemote = actions.findIndex((action) => action.kind === "step" && action.remote);
      actions.forEach((action, index) => {
        const id =
          action.kind === "task" ? action.id : action.kind === "question" ? action.key : "";
        if (afterInstall.has(id)) {
          assert.ok(index > installed && index < firstRemote, `${id} comes after the install`);
        } else if (
          (action.kind === "task" && firstBlock.has(action.id)) ||
          action.kind === "question"
        ) {
          assert.ok(index < firstChange, `${id} comes before the first change`);
        }
        if (action.kind === "task" && !firstBlock.has(action.id)) {
          const deployed = actions.findIndex((candidate) => candidate.kind === "wait");
          assert.ok(index > deployed, `${action.id} comes after the deploy`);
        }
      });
    });
  }

  test("the task count shrinks as the person finishes tasks", () => {
    const { actions } = walk(SCENARIOS["both github private"] ?? {}, WORLDS["a new account"]);
    const counts = actions.flatMap((action) =>
      action.kind === "task" && action.id !== "mcp-client" && action.id !== "renovate"
        ? [action.remaining]
        : [],
    );
    assert.ok(counts.length > 1);
    assert.deepEqual(
      counts,
      counts.toSorted((a, b) => b - a),
    );
    assert.equal(counts.at(-1), 1);
  });
});

/** One way to reopen a check on a finished run. */
type Breaker = {
  name: string;
  applies: (ctx: Context) => boolean;
  reopen: (ctx: Context) => void;
};

const always = () => true;

const BREAKERS: Breaker[] = [
  {
    name: "the GitHub CLI signed out",
    applies: always,
    reopen: (ctx) => (ctx.facts.github = null),
  },
  { name: "Wrangler signed out", applies: always, reopen: (ctx) => (ctx.facts.wrangler = null) },
  {
    name: "the Cloudflare CLI signed out",
    applies: (ctx) => accessUsed(ctx.answers),
    reopen: (ctx) => (ctx.facts.cf = null),
  },
  {
    name: "the Cloudflare CLI on another account",
    applies: (ctx) => accessUsed(ctx.answers),
    reopen: (ctx) => (ctx.facts.cf = { accountIds: ["ffffffffffffffffffffffffffffffff"] }),
  },
  { name: "no display name", applies: always, reopen: (ctx) => delete ctx.answers["display-name"] },
  { name: "no license answer", applies: always, reopen: (ctx) => delete ctx.answers.license },
  { name: "no hostname", applies: always, reopen: (ctx) => delete ctx.answers.hostname },
  {
    name: "a hostname off every zone",
    applies: always,
    reopen: (ctx) => {
      ctx.answers.hostname = "tools.example.org";
    },
  },
  {
    name: "no allowed GitHub accounts",
    applies: (ctx) => signIn(ctx.answers) === "github",
    reopen: (ctx) => delete ctx.answers["allowed-github"],
  },
  {
    name: "no one who may sign in",
    applies: (ctx) => accessUsed(ctx.answers),
    reopen: (ctx) => delete ctx.answers["who-may-sign-in"],
  },
  {
    name: "GitHub rejects the OAuth pair",
    applies: (ctx) => signIn(ctx.answers) === "github",
    reopen: (ctx) => (ctx.facts.githubOAuth.production = false),
  },
  {
    name: "the API token file is missing",
    applies: always,
    reopen: (ctx) => (ctx.facts.apiToken = { saved: false, valid: null }),
  },
  {
    name: "Cloudflare rejects the API token",
    applies: always,
    reopen: (ctx) => (ctx.facts.apiToken = { saved: true, valid: false }),
  },
  { name: "no summary", applies: always, reopen: (ctx) => delete ctx.local.summaryShown },
  { name: "no AGENTS.md block", applies: always, reopen: (ctx) => (ctx.repo.agentsBlock = false) },
  {
    name: "a file still names the template",
    applies: always,
    reopen: (ctx) => (ctx.repo.renameLeftovers = ["README.md"]),
  },
  {
    name: "an unpruned tree",
    applies: (ctx) =>
      !(hasMcp(ctx.answers) && ctx.answers.parts === "mcp,web" && signIn(ctx.answers) === "github"),
    reopen: (ctx) => (ctx.repo.tree = { parts: ["mcp", "web"], signIn: "github", pristine: true }),
  },
  { name: "no install", applies: always, reopen: (ctx) => (ctx.repo.installed = false) },
  {
    name: "a missing KV namespace",
    applies: (ctx) => hasMcp(ctx.answers),
    reopen: (ctx) => (ctx.facts.kvNamespaces.preview = null),
  },
  {
    name: "an Access policy that differs from who may sign in",
    applies: (ctx) => accessUsed(ctx.answers),
    reopen: (ctx) => {
      ctx.answers["who-may-sign-in"] = "grace@example.com";
    },
  },
  {
    name: "a missing Access application",
    applies: (ctx) => accessUsed(ctx.answers),
    reopen: (ctx) => (ctx.facts.accessApps.allow = null),
  },
  {
    name: "a pending config edit",
    applies: always,
    reopen: (ctx) => (ctx.repo.configPending = ["wrangler.jsonc"]),
  },
  {
    name: "a missing generated secret",
    applies: (ctx) => signIn(ctx.answers) === "github" || signIn(ctx.answers) === "bearer",
    reopen: (ctx) => {
      ctx.repo.devVars = {};
    },
  },
  { name: "an unverified tree", applies: always, reopen: (ctx) => (ctx.repo.verified = false) },
  { name: "uncommitted changes", applies: always, reopen: (ctx) => (ctx.repo.clean = false) },
  {
    name: "a changed Worker secret",
    applies: (ctx) => signIn(ctx.answers) === "github" || signIn(ctx.answers) === "bearer",
    reopen: (ctx) => (ctx.repo.secretSources.production = "hash:new"),
  },
  {
    name: "a missing Worker secret",
    applies: (ctx) => signIn(ctx.answers) === "github" || signIn(ctx.answers) === "bearer",
    reopen: (ctx) => (ctx.facts.workerSecrets = []),
  },
  {
    name: "a missing repository secret",
    applies: always,
    reopen: (ctx) => (ctx.facts.githubSecrets = ["CLOUDFLARE_ACCOUNT_ID"]),
  },
  {
    name: "a changed API token",
    applies: always,
    reopen: (ctx) => (ctx.repo.secretSources.apiToken = "hash:new-token"),
  },
  {
    name: "deploys turned off",
    applies: always,
    reopen: (ctx) => (ctx.facts.githubVariables.DEPLOY_ENABLED = "false"),
  },
  {
    name: "a stale description",
    applies: always,
    reopen: (ctx) => (ctx.facts.repository = { description: "Old." }),
  },
  { name: "HEAD not pushed", applies: always, reopen: (ctx) => (ctx.facts.pushed = false) },
  { name: "no deploy run yet", applies: always, reopen: (ctx) => (ctx.facts.deploy = null) },
  {
    name: "a deploy in progress",
    applies: always,
    reopen: (ctx) => {
      if (ctx.facts.deploy !== null) {
        ctx.facts.deploy.status = "pending";
      }
    },
  },
  {
    name: "a failed deploy",
    applies: always,
    reopen: (ctx) => {
      if (ctx.facts.deploy !== null) {
        ctx.facts.deploy.status = "failure";
      }
    },
  },
  { name: "no live checks", applies: always, reopen: (ctx) => (ctx.facts.live = null) },
  {
    name: "a failed live check",
    applies: always,
    reopen: (ctx) => (ctx.facts.live = [{ name: "healthz", ok: false, detail: "302 to Access" }]),
  },
  {
    name: "no MCP client answer",
    applies: (ctx) => hasMcp(ctx.answers),
    reopen: (ctx) => delete ctx.local.answers["mcp-client"],
  },
  {
    name: "a failed MCP sign-in",
    applies: (ctx) => hasMcp(ctx.answers),
    reopen: (ctx) => (ctx.local.answers["mcp-client"] = "failed"),
  },
  {
    name: "no Renovate answer",
    applies: always,
    reopen: (ctx) => delete ctx.local.answers.renovate,
  },
];

describe("done means no open check", () => {
  for (const [scenarioName, scenario] of Object.entries(SCENARIOS)) {
    test(`${scenarioName}: reopening any one check takes done away`, () => {
      const reference = doneContext(scenario);
      assert.equal(plan(reference).kind, "done");
      let reopened = 0;
      for (const breaker of BREAKERS) {
        const ctx = structuredClone(reference);
        if (!breaker.applies(ctx)) {
          continue;
        }
        breaker.reopen(ctx);
        reopened++;
        const action = plan(ctx);
        assert.notEqual(action.kind, "done", `done after ${breaker.name}`);
        assert.ok(openChecks(ctx).length > 0, `no open check after ${breaker.name}`);
      }
      assert.ok(reopened >= 25, `only ${String(reopened)} checks applied`);
    });

    test(`${scenarioName}: random combinations of reopened checks never yield done`, () => {
      const reference = doneContext(scenario);
      let seed = 7;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      for (let round = 0; round < 300; round++) {
        const ctx = structuredClone(reference);
        const applicable = BREAKERS.filter((breaker) => breaker.applies(ctx));
        const count = 1 + Math.floor(random() * 4);
        for (let index = 0; index < count; index++) {
          applicable[Math.floor(random() * applicable.length)]?.reopen(ctx);
        }
        assert.notEqual(plan(ctx).kind, "done");
        assert.equal(plan(ctx).kind === "done", openChecks(ctx).length === 0);
      }
    });
  }
});

describe("fixture mode", () => {
  const remoteSteps = [
    "workers-subdomain",
    "kv-namespaces",
    "access-otp",
    "access-apps",
    "worker-secrets",
    "preview-secrets",
    "github-secrets",
    "github-variables",
    "repository-description",
    "push",
    "live-checks",
  ].join(",");

  test("skipped remote steps count as done only in fixture mode", () => {
    const ctx = doneContext(SCENARIOS["both github private"] ?? {});
    ctx.facts.githubSecrets = [];
    ctx.local.fixtureSkipped = remoteSteps;
    assert.notEqual(plan(ctx).kind, "done");
    ctx.fixture = true;
    assert.deepEqual(plan(ctx), { kind: "done", skipped: ["github-secrets"] });
  });

  test("a skipped remote step never hides an open local check", () => {
    const ctx = doneContext(SCENARIOS["mcp bearer"] ?? {});
    ctx.fixture = true;
    ctx.local.fixtureSkipped = remoteSteps;
    ctx.repo.verified = false;
    assert.deepEqual(plan(ctx), { kind: "step", id: "verify", remote: false });
  });
});

describe("answers that change late", () => {
  test("a new display name runs the config, verify, commit, and push again", () => {
    const ctx = doneContext({ ...SHARED_ANSWERS, ...SCENARIOS["both access private"] });
    ctx.answers["display-name"] = "Acme Desk";
    ctx.repo.configPending = ["wrangler.jsonc"];
    ctx.repo.clean = false;
    ctx.repo.verified = false;
    ctx.facts.pushed = false;
    assert.deepEqual(plan(ctx), { kind: "step", id: "config", remote: false });
  });

  test("a new list of who may sign in updates the Access applications", () => {
    const ctx = doneContext(SCENARIOS["mcp access"] ?? {});
    ctx.local.answers["who-may-sign-in"] = "grace@example.com";
    ctx.answers["who-may-sign-in"] = "grace@example.com";
    assert.deepEqual(plan(ctx), { kind: "step", id: "access-apps", remote: true });
  });

  test("a failed deploy gets one rerun, then the script stops with the log", () => {
    const ctx = doneContext(SCENARIOS["web public"] ?? {});
    const deploy = {
      url: "https://example.com/run",
      status: "failure" as const,
      attempts: 1,
      runId: 7,
    };
    ctx.facts.deploy = deploy;
    assert.deepEqual(plan(ctx), { kind: "step", id: "deploy-rerun", remote: true });
    deploy.attempts = 2;
    assert.deepEqual(plan(ctx), { kind: "step", id: "deploy-failed", remote: true });
  });
});
