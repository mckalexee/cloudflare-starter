// Tests for bearer mode: the token check in front of the MCP handler.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBearerHandler } from "#auth/bearer.ts";

import { createMcpClient } from "../helpers/mcp.ts";

const TOKEN = "test-bearer-token";

afterEach(() => {
  vi.restoreAllMocks();
});

function clientWith(
  authorization: string | undefined,
  handler = createBearerHandler({ token: TOKEN }),
) {
  return createMcpClient((request) => handler.fetch(request, env, createExecutionContext()), {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

describe("bearer mode", () => {
  it("rejects a wrong token with a Bearer challenge that a browser client can read", async () => {
    const response = await clientWith("Bearer wrong-token").post("initialize");

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("WWW-Authenticate");
  });

  it("rejects a request without a token", async () => {
    const response = await clientWith(undefined).post("initialize");

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("serves MCP for the right token", async () => {
    const result = await clientWith(`Bearer ${TOKEN}`).initialize();

    expect(result.serverInfo.name).toBe("cloudflare-starter");
    expect(result.instructions).toContain("example_echo_message");
  });

  it("reads the token from MCP_BEARER_TOKEN when no override is given", async () => {
    const handler = createBearerHandler();
    const client = createMcpClient(
      (request) =>
        handler.fetch(request, { ...env, MCP_BEARER_TOKEN: TOKEN }, createExecutionContext()),
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );

    const result = await client.initialize();

    expect(result.serverInfo.name).toBe("cloudflare-starter");
  });

  it("ignores whitespace around the configured token", async () => {
    const handler = createBearerHandler();
    const client = createMcpClient(
      (request) =>
        handler.fetch(
          request,
          { ...env, MCP_BEARER_TOKEN: `${TOKEN}\n` },
          createExecutionContext(),
        ),
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );

    const result = await client.initialize();

    expect(result.serverInfo.name).toBe("cloudflare-starter");
  });

  it("rejects every request when no token is configured, and logs that once", async () => {
    // A fresh copy of the module, so that a log line from an earlier test can't hide this one.
    vi.resetModules();
    const fresh = await import("#auth/bearer.ts");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = clientWith(`Bearer ${TOKEN}`, fresh.createBearerHandler());

    const first = await client.post("initialize");
    const second = await client.post("initialize");

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    const events = errorLog.mock.calls.map(([line]) => String(line));
    expect(events.filter((line) => line.includes('"auth.bearer_token_missing"'))).toHaveLength(1);
  });
});
