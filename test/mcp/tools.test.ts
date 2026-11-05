// Tests for the shipped tools, called through the real MCP handler in workerd. They cover the
// tool list and its annotations, the server instructions, structured results, input validation,
// per-user state, and the scope check.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createBearerHandler } from "#auth/bearer.ts";
import { createMcpApiHandler } from "#mcp/handler.ts";
import { tools } from "#mcp/tools/index.ts";

import { createMcpClient, resultText } from "../helpers/mcp.ts";

const TOKEN = "test-bearer-token";

function ownerClient() {
  const handler = createBearerHandler({ token: TOKEN });
  return createMcpClient((request) => handler.fetch(request, env, createExecutionContext()), {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

describe("tools/list", () => {
  it("lists both tools with annotations that match their effects", async () => {
    const listed = (await ownerClient().listTools()).tools;

    const echo = listed.find((tool) => tool.name === "example_echo_message");
    const visit = listed.find((tool) => tool.name === "account_record_visit");
    expect(listed).toHaveLength(2);
    expect(echo?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(echo?.outputSchema).toBeDefined();
    expect(visit?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
});

describe("initialize", () => {
  it("lists every registered tool in the server instructions", async () => {
    const { instructions } = await ownerClient().initialize();

    for (const tool of tools) {
      expect(instructions).toContain(`- ${tool.name}: ${tool.title}.`);
    }
  });
});

describe("example_echo_message", () => {
  it("returns the message as JSON text and as structured content", async () => {
    const result = await ownerClient().callTool("example_echo_message", { message: "hello" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ message: "hello" });
    expect(JSON.parse(resultText(result))).toEqual({ message: "hello" });
  });

  // The SDK validates input before the tool runs and reports a failure as a tool error, not as a
  // JSON-RPC error, so the agent sees the problem and can retry.
  it("returns a tool error that names the invalid field when input is missing", async () => {
    const result = await ownerClient().callTool("example_echo_message", {});

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(
      "Input validation error: Invalid arguments for tool example_echo_message",
    );
    expect(resultText(result)).toContain("message");
  });
});

describe("account_record_visit", () => {
  it("adds one to the caller's visit count on each call", async () => {
    const client = ownerClient();

    const first = await client.callTool("account_record_visit");
    const second = await client.callTool("account_record_visit");

    // Bearer mode has no GitHub token for the owner.
    expect(first.structuredContent).toMatchObject({
      login: "owner",
      name: "Owner",
      hasUpstreamToken: false,
    });
    const firstVisits = Number(first.structuredContent?.visits);
    expect(second.structuredContent?.visits).toBe(firstVisits + 1);
    // Bearer mode gives the owner the account ID 0.
    expect(await env.OAUTH_KV.get("user:0:visits")).toBe(String(firstVisits + 1));
  });

  it("returns a tool error with a fix when the caller lacks the profile scope", async () => {
    const handler = createMcpApiHandler({
      authContext: { props: { id: 42, login: "guest", name: "Guest", scopes: [] } },
    });
    const client = createMcpClient((request) => handler(request, env, createExecutionContext()));

    const result = await client.callTool("account_record_visit");

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('needs the "profile" scope');
    expect(resultText(result)).toContain("Fix: Reconnect the server");
    expect(await env.OAUTH_KV.get("user:42:visits")).toBeNull();
  });
});
