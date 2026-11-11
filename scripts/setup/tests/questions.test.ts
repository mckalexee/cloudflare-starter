// Tests for the questions: each one is asked only when it applies, and `answer` refuses invalid
// values, irrelevant questions, and changes to answers that a step already used.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

import { plan } from "../planner.ts";
import { checkAnswer, question } from "../questions.ts";
import type { Context } from "../types.ts";
import {
  freshContext,
  SCENARIOS,
  SHARED_ANSWERS,
  walk,
  type Scenario,
  type WorldOptions,
} from "./world.ts";

// The questions that a scenario should hear, worked out from the rules in the brief rather than
// from the question specs, so the test can disagree with them.
function expectedQuestions(scenario: Scenario, world: WorldOptions): string[] {
  const parts = (scenario.parts ?? "").split(",");
  const mcp = parts.includes("mcp");
  const web = parts.includes("web");
  const mode = mcp ? scenario["sign-in"] : undefined;
  const access = (web && scenario["web-access"] === "private") || mode === "access";
  const expected = ["display-name", "description", "parts", "hostname", "license"];
  if (mcp) {
    expected.push("sign-in");
  }
  if (web) {
    expected.push("web-access");
  }
  if (access) {
    expected.push("who-may-sign-in");
  }
  if (world.accounts === 2) {
    expected.push("cloudflare-account");
  }
  if (world.subdomain === false) {
    expected.push("workers-subdomain");
  }
  if (mode === "github") {
    expected.push("allowed-github", "oauth-previews");
  }
  if (access && world.zeroTrust !== "with-pin") {
    expected.push("access-otp");
  }
  return expected.toSorted();
}

const WORLDS: WorldOptions[] = [
  { accounts: 1, subdomain: true, zeroTrust: "with-pin" },
  { accounts: 2, subdomain: false, zeroTrust: "none" },
  { accounts: 2, subdomain: true, zeroTrust: "cloudflare-only" },
];

describe("questions are asked only when relevant", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    WORLDS.forEach((world, index) => {
      test(`${name}, world ${String(index + 1)}`, () => {
        const { asked } = walk(scenario, world);
        assert.deepEqual(asked.toSorted(), expectedQuestions(scenario, world));
      });
    });
  }

  test("a clone without setup.local.json asks again only for who may sign in", () => {
    const ctx = walk(SCENARIOS["both access private"] ?? {}, WORLDS[0]).ctx;
    for (const key of ["who-may-sign-in", "mcp-client", "renovate"] as const) {
      delete ctx.answers[key];
    }
    ctx.local = { answers: {}, secretHashes: ctx.local.secretHashes, summaryShown: true };
    assert.deepEqual(plan(ctx), { kind: "question", key: "who-may-sign-in", problem: undefined });
    // The suggestion is the policy that the script reads back from the Access application.
    assert.equal(question("who-may-sign-in").suggest(ctx)?.value, "ada@example.com");
  });
});

/** A context partway through a run: the answers given, the logins done. */
function answered(scenario: Scenario): Context {
  const ctx = freshContext();
  Object.assign(ctx.answers, { ...SHARED_ANSWERS, ...scenario });
  ctx.facts.github = { login: "octocat" };
  ctx.facts.wrangler = { accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Acme" }] };
  ctx.facts.workersSubdomain = "acme";
  return ctx;
}

function refused(key: string, value: string, ctx: Context): string {
  const result = checkAnswer(key, value, ctx);
  assert.equal(result.ok, false, `${key}=${value} was accepted`);
  return result.ok ? "" : result.reason;
}

function accepted(key: string, value: string, ctx: Context): void {
  const result = checkAnswer(key, value, ctx);
  assert.ok(result.ok, result.ok ? "" : result.reason);
}

describe("answer", () => {
  test("refuses the project name and the owner, which come from the origin remote", () => {
    const ctx = freshContext();
    assert.match(refused("name", "other-name", ctx), /origin remote/);
    assert.match(refused("owner", "someone", ctx), /origin remote/);
  });

  test("refuses unknown keys and invalid values", () => {
    const ctx = answered(SCENARIOS["both github public"] ?? {});
    assert.match(refused("colour", "blue", ctx), /no question named colour/);
    refused("parts", "api", ctx);
    refused("sign-in", "password", ctx);
    refused("hostname", "not a host", ctx);
    refused("description", "Tracks requests. Sends mail.", ctx);
    refused("display-name", "Acme `Tools`", ctx);
    refused("who-may-sign-in", "not-an-email@", answered(SCENARIOS["web private"] ?? {}));
    refused("allowed-github", "has space", ctx);
    refused("cloudflare-account", "acme", ctx);
    refused("mcp-client", "maybe", ctx);
  });

  test("refuses questions that the answers so far make irrelevant", () => {
    const mcpOnly = answered(SCENARIOS["mcp access"] ?? {});
    assert.match(refused("web-access", "private", mcpOnly), /keeps the web app/);
    refused("allowed-github", "octocat", mcpOnly);
    refused("oauth-previews", "yes", mcpOnly);
    const webOnly = answered(SCENARIOS["web public"] ?? {});
    refused("sign-in", "github", webOnly);
    refused("who-may-sign-in", "ada@example.com", webOnly);
    refused("mcp-client", "done", webOnly);
    const fresh = freshContext();
    refused("sign-in", "github", fresh);
  });

  test("refuses workers.dev where a private web app sits next to GitHub OAuth or bearer mode", () => {
    for (const name of ["both github private", "both bearer private"]) {
      const ctx = answered(SCENARIOS[name] ?? {});
      assert.match(refused("hostname", "workers.dev", ctx), /custom domain/);
      accepted("hostname", "app.example.com", ctx);
    }
    accepted("hostname", "workers.dev", answered(SCENARIOS["both access private"] ?? {}));
  });

  test("refuses a new parts or sign-in answer after the prune step ran", () => {
    const pruned = answered(SCENARIOS["mcp bearer"] ?? {});
    pruned.repo.tree = { parts: ["mcp"], signIn: "bearer", pristine: false };
    assert.match(refused("parts", "mcp,web", pruned), /prune step/);
    assert.match(refused("sign-in", "github", pruned), /prune step/);
    accepted("sign-in", "bearer", pruned);

    // Keeping the template as it is prunes nothing, so the step counts as run once the setup
    // has started changing the tree.
    const kept = answered(SCENARIOS["both github public"] ?? {});
    accepted("parts", "mcp", kept);
    kept.repo.agentsBlock = true;
    assert.match(refused("parts", "mcp", kept), /prune step/);
  });

  test("allows a new parts answer before the prune step", () => {
    const ctx = answered(SCENARIOS["mcp bearer"] ?? {});
    ctx.repo.agentsBlock = true;
    accepted("parts", "web", ctx);
    accepted("sign-in", "access", ctx);
  });

  test("refuses a new hostname once the config, an Access application, or a variable uses it", () => {
    const configured = answered(SCENARIOS["both github private"] ?? {});
    configured.repo.configuredHost = "tools.example.com";
    assert.match(refused("hostname", "app.example.com", configured), /wrangler\.jsonc/);
    accepted("hostname", "tools.example.com", configured);

    const protectedHost = answered(SCENARIOS["mcp access"] ?? {});
    protectedHost.facts.accessApps.allow = {
      id: "app",
      aud: "aud",
      domain: "acme-tools.acme.workers.dev",
      destinations: ["acme-tools.acme.workers.dev"],
      include: ["email:ada@example.com"],
      managedOAuth: true,
    };
    assert.match(refused("hostname", "app.example.com", protectedHost), /Access applications/);

    const variable = answered(SCENARIOS["web public"] ?? {});
    variable.facts.githubVariables.HEALTHCHECK_URL = "https://acme-tools.acme.workers.dev";
    assert.match(refused("hostname", "app.example.com", variable), /HEALTHCHECK_URL/);

    accepted("hostname", "app.example.com", answered(SCENARIOS["web public"] ?? {}));
  });

  test("allows who may sign in, allowed accounts, display name, and description at any time", () => {
    for (const name of ["both github private", "both access private"]) {
      const ctx = walk(SCENARIOS[name] ?? {}).ctx;
      accepted("display-name", "Acme Desk", ctx);
      accepted("description", "Answers questions about the Acme team.", ctx);
      accepted("description", "none", ctx);
      if (name === "both github private") {
        accepted("allowed-github", "octocat,hubot", ctx);
        accepted("allowed-github", "*", ctx);
      }
      accepted("who-may-sign-in", "grace@example.com,example.org", ctx);
    }
  });

  test("keeps who may sign in and the last tasks out of setup.json", () => {
    const ctx = answered(SCENARIOS["both access private"] ?? {});
    for (const [key, value] of [
      ["who-may-sign-in", "ada@example.com"],
      ["mcp-client", "not-now"],
      ["renovate", "done"],
    ] as const) {
      const result = checkAnswer(key, value, ctx);
      assert.ok(result.ok && result.store === "local", key);
    }
    const shared = checkAnswer("display-name", "Acme", ctx);
    assert.ok(shared.ok && shared.store === "shared");
  });

  test("normalizes values", () => {
    const ctx = answered(SCENARIOS["both access public"] ?? {});
    assert.deepEqual(checkAnswer("parts", "web,mcp", ctx), {
      ok: true,
      key: "parts",
      value: "mcp,web",
      store: "shared",
    });
    const description = checkAnswer("description", "Tracks requests", ctx);
    assert.ok(description.ok && description.value === "Tracks requests.");
    const people = checkAnswer("who-may-sign-in", " Ada@Example.com , example.com ", ctx);
    assert.ok(people.ok && people.value === "ada@example.com,example.com");
  });
});
