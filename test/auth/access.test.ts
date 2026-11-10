// Tests for Cloudflare Access sign-in on the MCP endpoint: the identity check in front of the MCP
// handler, the props it builds, the cross-origin rule, and the protected resource metadata.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { accessRoutes, PROTECTED_RESOURCE_PATH } from "#auth/access.ts";

import { type AccessIssuer, AUD, createAccessIssuer, useAccessVars } from "../helpers/access.ts";
import { createMcpClient } from "../helpers/mcp.ts";
import { useNetwork } from "../helpers/network.ts";

const network = useNetwork();
const setAccessVars = useAccessVars();
let issuer: AccessIssuer;

beforeAll(async () => {
  issuer = await createAccessIssuer();
});

beforeEach(() => {
  network.use(issuer.certs);
  setAccessVars(issuer.teamDomain, AUD);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Routes = typeof accessRoutes;

function clientWith(
  headers: Record<string, string>,
  ctx: object = {},
  routes: Routes = accessRoutes,
) {
  const context = Object.assign(createExecutionContext(), ctx);
  return createMcpClient(async (request) => routes.fetch(request, env, context), { headers });
}

function accessContext(aud: string) {
  return { access: { aud, getIdentity: () => Promise.resolve({ email: "ada@example.com" }) } };
}

async function signedIn(email = "ada@example.com") {
  return { "cf-access-jwt-assertion": await issuer.sign({ email }) };
}

describe("MCP with Cloudflare Access sign-in", () => {
  it("serves MCP to a request with a valid Access JWT", async () => {
    const result = await clientWith(await signedIn()).initialize();

    expect(result.serverInfo.name).toBe("cloudflare-starter");
  });

  it("keys per-user data by the lowercase email", async () => {
    const client = clientWith(await signedIn("Grace.Hopper@Example.com"));

    const result = await client.callTool("account_record_visit");

    expect(result.isError).not.toBe(true);
    expect(await env.OAUTH_KV.get("user:grace.hopper@example.com:visits")).toBe("1");
  });

  it("sends no CORS headers, so no other site can read a response", async () => {
    const response = await clientWith(await signedIn()).post("initialize");

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("answers 401 with a Bearer challenge without an identity", async () => {
    const response = await clientWith({}).post("initialize");

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({
      error: { message: "This endpoint requires a Cloudflare Access identity." },
    });
  });

  it("answers 401 for a JWT from another Access application", async () => {
    const token = await issuer.sign({ email: "ada@example.com" }, { audience: "another-app" });

    const response = await clientWith({ "cf-access-jwt-assertion": token }).post("initialize");

    expect(response.status).toBe(401);
  });

  it("accepts ctx.access only for the configured application", async () => {
    const matching = await clientWith({}, accessContext(AUD)).post("initialize");
    const foreign = await clientWith({}, accessContext("another-app")).post("initialize");

    expect(matching.status).toBe(200);
    expect(foreign.status).toBe(401);
  });

  it("answers 502 when the Access certificates endpoint can't be reached", async () => {
    // No handler serves this issuer's certificates, so the request fails with a network error.
    const unreachable = await createAccessIssuer();
    setAccessVars(unreachable.teamDomain, AUD);
    const token = await unreachable.sign({ email: "ada@example.com" });

    const response = await clientWith({ "cf-access-jwt-assertion": token }).post("initialize");

    expect(response.status).toBe(502);
  });

  it("answers 401 to every request without the Access vars, and logs that once", async () => {
    // A fresh copy of the module, so that a log line from an earlier test can't hide this one.
    vi.resetModules();
    const fresh = await import("#auth/access.ts");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    setAccessVars("", "");
    const client = clientWith(await signedIn(), {}, fresh.accessRoutes);

    const first = await client.post("initialize");
    const second = await client.post("initialize");

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    const events = errorLog.mock.calls.map(([line]) => String(line));
    expect(events.filter((line) => line.includes('"auth.access_unconfigured"'))).toHaveLength(1);
  });
});

describe("the cross-origin rule", () => {
  it("answers 403 to a browser request from another origin, even with an identity", async () => {
    const headers = { ...(await signedIn()), Origin: "https://evil.example.com" };

    const response = await clientWith(headers).post("initialize");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { message: "Cross-origin requests to the MCP endpoint aren't allowed." },
    });
  });

  it("answers 403 to a same-site request from a sibling host", async () => {
    const headers = { ...(await signedIn()), "Sec-Fetch-Site": "same-site" };

    const response = await clientWith(headers).post("initialize");

    expect(response.status).toBe(403);
  });

  it("serves a browser request from the endpoint's own origin", async () => {
    const headers = {
      ...(await signedIn()),
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
    };

    const result = await clientWith(headers).initialize();

    expect(result.serverInfo.name).toBe("cloudflare-starter");
  });
});

describe("protected resource metadata", () => {
  it.each([PROTECTED_RESOURCE_PATH, `${PROTECTED_RESOURCE_PATH}/mcp`])(
    "names the endpoint and the Access team at %s",
    async (path) => {
      const response = await accessRoutes.fetch(
        new Request(`https://mcp.example.com${path}`),
        env,
        createExecutionContext(),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resource: "https://mcp.example.com/mcp",
        authorization_servers: [`https://${issuer.teamDomain}`],
        bearer_methods_supported: ["header"],
      });
    },
  );

  it("answers 404 without the Access vars", async () => {
    setAccessVars("", "");

    const response = await accessRoutes.fetch(
      new Request(`https://mcp.example.com${PROTECTED_RESOURCE_PATH}/mcp`),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });
});
