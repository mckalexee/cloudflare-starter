// Tests for the remote steps and probes against fake commands and fake HTTP: what each step runs,
// that secrets travel only on standard input or in temporary files and never reach the output,
// and that "done" rests on the deploy job and the live checks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { StepError } from "../exec.ts";
import { loadContext, RefusalError } from "../probes.ts";
import { REMOTE_STEPS } from "../remote-steps.ts";
import {
  accessAppFact,
  githubPairAccepted,
  liveChecks,
  readDeploy,
  REAL_PROBES,
} from "../remote.ts";
import { readLocal, readResources } from "../state.ts";
import { contextWithFiles, fake, isTool } from "./fakes.ts";

// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

const SECRET = "s3cr3t-value-that-must-never-print";

function only<T>(items: T[]): T {
  assert.equal(items.length, 1);
  const [item] = items;
  assert.ok(item !== undefined);
  return item;
}

function assertNotPrinted(printed: string[], ...secrets: string[]): void {
  const output = printed.join("\n");
  for (const secret of secrets) {
    assert.ok(!output.includes(secret), "a secret value reached the output");
  }
}

describe("remote steps", () => {
  test("github-secrets sends the token on standard input and records its hash", () => {
    const ctx = contextWithFiles({ parts: "web", "web-access": "public" });
    writeFileSync(ctx.repo.apiTokenFile, `${SECRET}\n`);
    ctx.repo.secretSources.apiToken = "hash:token";
    const recorder = fake();
    try {
      REMOTE_STEPS["github-secrets"](ctx);
    } finally {
      recorder.restore();
    }
    const [token, account] = recorder.calls;
    assert.deepEqual(token?.args, [
      "secret",
      "set",
      "CLOUDFLARE_API_TOKEN",
      "--repo",
      "octocat/acme-tools",
    ]);
    assert.equal(token?.stdin, SECRET);
    assert.deepEqual(account?.args.slice(-2), ["--body", "0123456789abcdef0123456789abcdef"]);
    for (const call of recorder.calls) {
      assert.ok(!call.args.join(" ").includes(SECRET), "the token appeared in the arguments");
    }
    assertNotPrinted(recorder.printed, SECRET);
    assert.equal(readLocal(ctx.repo.root).secretHashes.apiToken, "hash:token");
  });

  test("worker-secrets sends the JSON on standard input, with a new cookie secret", () => {
    const ctx = contextWithFiles(
      { parts: "mcp", "sign-in": "github" },
      {
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: SECRET,
        COOKIE_SECRET: "local-cookie",
      },
    );
    const recorder = fake(
      [
        (call) =>
          call.args.includes("token") ? { stdout: '{"token":"wrangler-token"}' } : undefined,
      ],
      [
        () => ({
          body: '{"success":true,"result":{"default_environment":{"script_tag":"tag-1"}}}',
        }),
      ],
    );
    try {
      REMOTE_STEPS["worker-secrets"](ctx);
    } finally {
      recorder.restore();
    }
    const bulk = recorder.calls.find((call) => isTool(call, "wrangler", "secret", "bulk"));
    assert.ok(bulk !== undefined);
    assert.deepEqual(bulk.args, ["secret", "bulk", "--name", "acme-tools"]);
    const uploaded: unknown = JSON.parse(bulk.stdin ?? "{}");
    assert.ok(typeof uploaded === "object" && uploaded !== null);
    assert.deepEqual(Object.keys(uploaded).toSorted(), [
      "COOKIE_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ]);
    assert.ok(
      !(bulk.stdin ?? "").includes("local-cookie"),
      "production reused the local cookie secret",
    );
    assert.equal(bulk.env.CLOUDFLARE_ACCOUNT_ID, "0123456789abcdef0123456789abcdef");
    assertNotPrinted(recorder.printed, SECRET);
    // The first upload creates the Worker, so setup records it as its own.
    assert.equal(readResources(ctx.repo.root).worker, "tag-1");
  });

  test("preview-secrets puts each Preview value on standard input under the Worker's names", () => {
    const ctx = contextWithFiles(
      { parts: "mcp", "sign-in": "github", "oauth-previews": "yes" },
      { PREVIEW_GITHUB_CLIENT_ID: "preview-id", PREVIEW_GITHUB_CLIENT_SECRET: SECRET },
    );
    const recorder = fake();
    try {
      REMOTE_STEPS["preview-secrets"](ctx);
    } finally {
      recorder.restore();
    }
    assert.deepEqual(
      recorder.calls.map((call) => [
        call.args[4],
        call.stdin === SECRET ? "<secret>" : call.stdin?.length,
      ]),
      [
        ["GITHUB_CLIENT_ID", "preview-id".length],
        ["GITHUB_CLIENT_SECRET", "<secret>"],
        ["COOKIE_SECRET", 64],
      ],
    );
    for (const call of recorder.calls) {
      assert.ok(isTool(call, "wrangler", "preview", "base-config", "secret", "put"));
      assert.ok(!call.args.join(" ").includes(SECRET), "a secret appeared in the arguments");
    }
    assertNotPrinted(recorder.printed, SECRET);
  });

  test("kv-namespaces creates only the missing namespaces and records their IDs", () => {
    const ctx = contextWithFiles({ parts: "mcp", "sign-in": "bearer" });
    ctx.facts.kvNamespaces = { production: "existing", preview: null };
    const recorder = fake([
      (call) =>
        call.args.join(" ") === "kv namespace list"
          ? {
              stdout:
                '[{"id":"existing","title":"acme-tools-kv"},{"id":"new-id","title":"acme-tools-kv-preview"}]',
            }
          : undefined,
    ]);
    try {
      REMOTE_STEPS["kv-namespaces"](ctx);
    } finally {
      recorder.restore();
    }
    assert.ok(
      isTool(
        only(recorder.calls.filter((call) => call.args[2] === "create")),
        "wrangler",
        "kv",
        "namespace",
        "create",
        "acme-tools-kv-preview",
      ),
    );
    assert.deepEqual(readResources(ctx.repo.root), { kvPreview: "new-id" });
  });

  test("access-apps creates the bypass application first, then the allow application", () => {
    const ctx = contextWithFiles({
      parts: "mcp,web",
      "sign-in": "access",
      "web-access": "private",
      hostname: "workers.dev",
      "who-may-sign-in": "ada@example.com,example.com",
    });
    let created = 0;
    const recorder = fake([
      (call) =>
        call.args[3] === "create"
          ? { stdout: `{"id":"app-${String(++created)}","aud":"aud"}` }
          : undefined,
    ]);
    try {
      REMOTE_STEPS["access-apps"](ctx);
    } finally {
      recorder.restore();
    }
    const bodies = recorder.calls.map((call) => {
      assert.ok(isTool(call, "cf", "zero-trust", "access", "applications", "create"));
      const parsed: unknown = JSON.parse(call.args.at(-1) ?? "{}");
      assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
      return new Map(Object.entries(parsed));
    });
    assert.equal(bodies[0]?.get("name"), "acme-tools health check");
    assert.equal(bodies[0]?.get("domain"), "acme-tools.acme.workers.dev/healthz");
    assert.equal(bodies[1]?.get("name"), "acme-tools");
    assert.ok(
      bodies[1]?.get("oauth_configuration") !== undefined,
      "Access sign-in needs Managed OAuth",
    );
    assert.deepEqual(bodies[1]?.get("policies"), [
      {
        name: "Allowed people",
        decision: "allow",
        include: [
          { email_domain: { domain: "example.com" } },
          { email: { email: "ada@example.com" } },
        ],
      },
    ]);
    assert.deepEqual(readResources(ctx.repo.root), { accessAllow: "app-2", accessBypass: "app-1" });
    // The policy holds email addresses, so the printed command shows a placeholder.
    assertNotPrinted(recorder.printed, "ada@example.com");
  });

  test("access-apps updates its own applications and refuses someone else's", () => {
    const ctx = contextWithFiles({
      parts: "web",
      "web-access": "private",
      hostname: "workers.dev",
      "who-may-sign-in": "grace@example.com",
    });
    const app = { aud: "aud", destinations: [], include: [], managedOAuth: false };
    ctx.facts.accessApps = {
      // The bypass application is ours by its recorded ID, the allow application by its domain.
      allow: { ...app, id: "allow-id", domain: "acme-tools.acme.workers.dev" },
      bypass: { ...app, id: "bypass-id", domain: "elsewhere.example.com" },
    };
    ctx.resources.accessBypass = "bypass-id";
    let recorder = fake();
    try {
      REMOTE_STEPS["access-apps"](ctx);
    } finally {
      recorder.restore();
    }
    assert.deepEqual(
      recorder.calls.map((call) => call.args.slice(3, 5)),
      [
        ["update", "bypass-id"],
        ["update", "allow-id"],
      ],
    );
    // An application with the wanted name on another domain, whose ID setup never recorded.
    ctx.resources = {};
    ctx.facts.accessApps.allow = { ...app, id: "other-id", domain: "other.example.com" };
    ctx.facts.accessApps.bypass = null;
    recorder = fake();
    try {
      assert.throws(() => REMOTE_STEPS["access-apps"](ctx), /belongs to something else/);
    } finally {
      recorder.restore();
    }
    assert.ok(!recorder.calls.some((call) => call.args.includes("other-id")));
  });

  test("access-otp adds the one-time PIN login method", () => {
    const ctx = contextWithFiles({ parts: "web", "web-access": "private" });
    const recorder = fake();
    try {
      REMOTE_STEPS["access-otp"](ctx);
    } finally {
      recorder.restore();
    }
    assert.ok(isTool(only(recorder.calls), "cf", "zero-trust", "identity-providers", "create"));
    assert.match(recorder.calls[0]?.args.at(-1) ?? "", /"type":"onetimepin"/);
  });

  test("workers-subdomain claims the subdomain with Wrangler's login", () => {
    const ctx = contextWithFiles({ parts: "web", "workers-subdomain": "acme" });
    ctx.facts.workersSubdomain = null;
    const recorder = fake(
      [
        (call) =>
          call.args.includes("token")
            ? { stdout: `{"type":"oauth","token":"${SECRET}"}` }
            : undefined,
      ],
      [
        (request) =>
          request.method === "PUT"
            ? { body: '{"success":true,"result":{"subdomain":"acme"}}' }
            : undefined,
      ],
    );
    try {
      REMOTE_STEPS["workers-subdomain"](ctx);
    } finally {
      recorder.restore();
    }
    const [request] = recorder.requests;
    assert.equal(
      request?.url,
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/subdomain",
    );
    assert.equal(request?.body, '{"subdomain":"acme"}');
    assert.equal(request?.headers?.authorization, `Bearer ${SECRET}`);
    assertNotPrinted(recorder.printed, SECRET);
  });

  test("github-variables, repository-description, and push run the expected commands", () => {
    const ctx = contextWithFiles({
      parts: "web",
      hostname: "tools.example.com",
      description: "Tracks requests.",
    });
    const recorder = fake();
    try {
      REMOTE_STEPS["github-variables"](ctx);
      REMOTE_STEPS["repository-description"](ctx);
      REMOTE_STEPS.push(ctx);
    } finally {
      recorder.restore();
    }
    assert.deepEqual(
      recorder.calls.map((call) => [call.command, ...call.args].join(" ")),
      [
        "gh variable set DEPLOY_ENABLED --repo octocat/acme-tools --body true",
        "gh variable set HEALTHCHECK_URL --repo octocat/acme-tools --body https://tools.example.com",
        "gh repo edit octocat/acme-tools --description Tracks requests.",
        "git push origin HEAD:main",
      ],
    );
  });

  test("a failed deploy gets one rerun, and a second failure stops with the log", () => {
    const ctx = contextWithFiles({ parts: "web" });
    ctx.facts.deploy = {
      url: "https://example.com/run/9",
      status: "failure",
      attempts: 1,
      runId: 9,
      conclusion: "failure",
    };
    const recorder = fake();
    try {
      REMOTE_STEPS["deploy-rerun"](ctx);
      assert.throws(() => REMOTE_STEPS["deploy-failed"](ctx), StepError);
    } finally {
      recorder.restore();
    }
    assert.deepEqual(recorder.calls[0]?.args, [
      "run",
      "rerun",
      "9",
      "--failed",
      "--repo",
      "octocat/acme-tools",
    ]);
    assert.deepEqual(recorder.calls[1]?.args.slice(0, 4), ["run", "view", "9", "--log-failed"]);
  });

  test("live-checks reports the failed checks and stops", () => {
    const ctx = contextWithFiles({ parts: "web" });
    ctx.facts.live = [{ name: "healthz", ok: false, detail: "GET /healthz answered 302" }];
    const recorder = fake();
    try {
      assert.throws(() => REMOTE_STEPS["live-checks"](ctx), StepError);
    } finally {
      recorder.restore();
    }
    assert.ok(recorder.printed.some((line) => line.includes("GET /healthz answered 302")));
  });
});

function runs(jobConclusion: string | null, runStatus = "completed") {
  return (call: { args: string[] }) => {
    const route = call.args[1] ?? "";
    if (route.includes("/workflows/deploy.yml/runs")) {
      return {
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 5,
              html_url: "https://example.com/runs/5",
              status: runStatus,
              conclusion: "success",
              run_attempt: 1,
            },
          ],
        }),
      };
    }
    if (route.endsWith("/runs/5/jobs")) {
      return {
        stdout: JSON.stringify({
          jobs: [
            { name: "CI / Verify", status: "completed", conclusion: "success" },
            ...(jobConclusion === null
              ? []
              : [{ name: "Deploy to production", status: "completed", conclusion: jobConclusion }]),
          ],
        }),
      };
    }
    return undefined;
  };
}

describe("done is evidence", () => {
  test("a skipped deploy job is a failure, even when the run concluded success", () => {
    const ctx = contextWithFiles({ parts: "web" });
    const recorder = fake([runs("skipped")]);
    try {
      assert.deepEqual(readDeploy(ctx, "abc"), {
        url: "https://example.com/runs/5",
        attempts: 1,
        runId: 5,
        status: "failure",
        conclusion: "skipped",
      });
    } finally {
      recorder.restore();
    }
  });

  test("the deploy job's own success counts, and an unfinished run is pending", () => {
    const ctx = contextWithFiles({ parts: "web" });
    let recorder = fake([runs("success")]);
    try {
      assert.equal(readDeploy(ctx, "abc")?.status, "success");
    } finally {
      recorder.restore();
    }
    recorder = fake([runs(null, "in_progress")]);
    try {
      assert.equal(readDeploy(ctx, "abc")?.status, "pending");
    } finally {
      recorder.restore();
    }
  });

  test("a redirect to the Access login fails the health check", () => {
    const ctx = contextWithFiles({ parts: "web", "web-access": "public", hostname: "workers.dev" });
    const recorder = fake(
      [],
      [
        () => ({
          status: 302,
          headers: { location: "https://acme.cloudflareaccess.com/cdn-cgi/access/login/x" },
        }),
      ],
    );
    try {
      const [healthz] = liveChecks(ctx);
      assert.equal(healthz?.ok, false);
    } finally {
      recorder.restore();
    }
  });

  test("each sign-in mode expects its own challenge", () => {
    const challenges: Record<string, string> = {
      github:
        'Bearer resource_metadata="https://acme-tools.acme.workers.dev/.well-known/oauth-protected-resource/mcp"',
      access:
        'Bearer realm="OAuth", error="invalid_token", resource_metadata="https://acme-tools.acme.workers.dev/.well-known/cloudflare-access-protected-resource/mcp"',
      bearer: "Bearer",
    };
    for (const [mode, header] of Object.entries(challenges)) {
      const ctx = contextWithFiles(
        { parts: "mcp", "sign-in": mode, hostname: "workers.dev" },
        { MCP_BEARER_TOKEN: SECRET },
      );
      const recorder = fake(
        [],
        [
          (request) => (request.url.endsWith("/healthz") ? { body: '{"ok":true}' } : undefined),
          (request) =>
            request.headers?.authorization === `Bearer ${SECRET}`
              ? { body: '{"result":{"serverInfo":{"name":"x"}}}' }
              : { status: 401, headers: { "www-authenticate": header } },
        ],
      );
      try {
        const checks = liveChecks(ctx);
        // A pass says what the script saw and that it matched, never what it expected instead.
        for (const check of checks) {
          assert.match(check.detail, /which matches/);
          assert.doesNotMatch(check.detail, /Expected/);
        }
        assert.ok(
          checks.every((check) => check.ok),
          `${mode}: ${JSON.stringify(checks)}`,
        );
        assert.equal(checks.length, mode === "bearer" ? 3 : 2);
        // The Worker's own 401 doesn't prove that Access is in front.
        if (mode === "access") {
          recorder.restore();
          const worker = fake(
            [],
            [
              (request) => (request.url.endsWith("/healthz") ? { body: '{"ok":true}' } : undefined),
              () => ({ status: 401, headers: { "www-authenticate": "Bearer" } }),
            ],
          );
          try {
            assert.equal(liveChecks(ctx)[1]?.ok, false);
          } finally {
            worker.restore();
          }
        }
      } finally {
        recorder.restore();
      }
    }
  });
});

describe("probes", () => {
  test("GitHub accepts an OAuth pair only when it answers bad_verification_code", () => {
    for (const [error, expected] of [
      ["bad_verification_code", true],
      ["incorrect_client_credentials", false],
    ] as const) {
      const recorder = fake([], [() => ({ body: JSON.stringify({ error }) })]);
      try {
        assert.equal(githubPairAccepted("id", SECRET), expected);
        assert.ok(!recorder.requests[0]?.url.includes(SECRET), "the secret went into the URL");
      } finally {
        recorder.restore();
      }
    }
  });

  test("the API token is verified against the account and cached once valid", () => {
    const ctx = contextWithFiles({ parts: "web" });
    writeFileSync(ctx.repo.apiTokenFile, SECRET);
    const recorder = fake([], [() => ({ body: '{"success":true,"result":{"status":"active"}}' })]);
    try {
      assert.deepEqual(REAL_PROBES.apiToken(ctx), { saved: true, valid: true });
      assert.equal(
        recorder.requests[0]?.url,
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/tokens/verify",
      );
      ctx.local = readLocal(ctx.repo.root);
      assert.deepEqual(REAL_PROBES.apiToken(ctx), { saved: true, valid: true });
      assert.equal(recorder.requests.length, 1, "a valid token was checked twice");
    } finally {
      recorder.restore();
    }
  });

  test("both Cloudflare logins must name the same account", () => {
    const ctx = contextWithFiles({ parts: "web", "web-access": "private" });
    const recorder = fake([
      (call) =>
        call.args[0] === "auth"
          ? {
              stdout:
                '{"authenticated":true,"tokenValid":true,"accounts":[{"id":"ffffffffffffffffffffffffffffffff"}]}',
            }
          : undefined,
    ]);
    try {
      assert.deepEqual(REAL_PROBES.cf(ctx), { accountIds: ["ffffffffffffffffffffffffffffffff"] });
    } finally {
      recorder.restore();
    }
  });

  test("an Access application from the API becomes the fact the planner compares", () => {
    const fact = accessAppFact({
      id: "id",
      aud: "aud",
      domain: "tools.example.com",
      destinations: [{ type: "public", uri: "tools.example.com" }],
      policies: [
        {
          decision: "allow",
          include: [
            { email: { email: "Ada@Example.com" } },
            { email_domain: { domain: "example.com" } },
          ],
        },
      ],
      oauth_configuration: { enabled: true },
    });
    assert.deepEqual(fact, {
      id: "id",
      aud: "aud",
      domain: "tools.example.com",
      destinations: ["tools.example.com"],
      include: ["domain:example.com", "email:ada@example.com"],
      managedOAuth: true,
    });
  });

  test("setup stops while CLOUDFLARE_API_TOKEN is set", () => {
    const root = mkdtempSync(path.join(tmpdir(), "setup-token-test-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/acme-tools.git"], {
      cwd: root,
    });
    writeFileSync(path.join(root, "package.json"), "{}\n");
    writeFileSync(path.join(root, ".env"), "CLOUDFLARE_API_TOKEN=abc\n");
    assert.throws(
      () => loadContext(root),
      (error) => error instanceof RefusalError && /\.env/.test(error.message),
    );
    writeFileSync(path.join(root, ".env"), "OTHER=1\n");
    const previous = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "abc";
    try {
      assert.throws(
        () => loadContext(root),
        (error) => error instanceof RefusalError && /environment/.test(error.message),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.CLOUDFLARE_API_TOKEN;
      } else {
        process.env.CLOUDFLARE_API_TOKEN = previous;
      }
    }
    assert.ok(readFileSync(path.join(root, ".env"), "utf8").includes("OTHER"));
  });
});
