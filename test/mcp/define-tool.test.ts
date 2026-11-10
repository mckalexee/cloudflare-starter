// Tests for `defineTool`: the annotations it derives from a tool's effect, the line it logs for
// each call, and the error mapping. Each error test registers a tool that throws and checks the
// tool result the client receives.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { HttpError, UpstreamError } from "#lib/errors.ts";
import { defineTool, type ToolRegistration } from "#mcp/define-tool.ts";
import { ToolInputError } from "#mcp/errors.ts";

import { createMcpClient, resultText } from "../helpers/mcp.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function clientWith(tool: ToolRegistration) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    tool.register(server, { env, props: { id: "1", login: "tester", name: "Tester", scopes: [] } });
    return server;
  });
  return createMcpClient((request) => handler(request, env, createExecutionContext()));
}

function clientFor(error: Error) {
  return clientWith(
    defineTool({
      name: "test_fail_always",
      title: "Fail",
      description: "Throws the error under test.",
      effect: "read",
      input: z.object({}),
      handler: async () => {
        throw error;
      },
    }),
  );
}

describe("defineTool annotations", () => {
  it("derives the hints from the effect and the open-world flag", async () => {
    const client = clientWith(
      defineTool({
        name: "test_delete_message",
        title: "Delete a message",
        description: "Deletes a message in another system.",
        effect: "destructive",
        openWorld: true,
        input: z.object({}),
        handler: async () => null,
      }),
    );

    const { tools } = await client.listTools();

    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

// The parsed `mcp.tool_called` lines from a `console.info` spy.
function calledLines(info: { mock: { calls: unknown[][] } }): unknown[] {
  return info.mock.calls
    .map(([line]): unknown => JSON.parse(String(line)))
    .filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "event" in entry &&
        entry.event === "mcp.tool_called",
    );
}

describe("defineTool call log", () => {
  it("logs a successful call with the tool, the login, and the duration", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = clientWith(
      defineTool({
        name: "test_echo_input",
        title: "Echo",
        description: "Returns its input.",
        effect: "read",
        input: z.object({ text: z.string() }),
        handler: async ({ text }) => ({ text }),
      }),
    );

    const result = await client.callTool("test_echo_input", { text: "hello" });

    expect(result.isError).toBeFalsy();
    expect(calledLines(info)).toEqual([
      {
        level: "info",
        event: "mcp.tool_called",
        tool: "test_echo_input",
        login: "tester",
        durationMs: expect.any(Number),
        isError: false,
      },
    ]);
  });

  it("logs a call that returns a tool error", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = clientFor(new ToolInputError("The folder doesn't exist.", "List folders."));

    const result = await client.callTool("test_fail_always");

    expect(result.isError).toBe(true);
    expect(calledLines(info)).toEqual([
      {
        level: "info",
        event: "mcp.tool_called",
        tool: "test_fail_always",
        login: "tester",
        durationMs: expect.any(Number),
        isError: true,
      },
    ]);
  });
});

describe("defineTool error mapping", () => {
  it("turns a ToolInputError into a tool error with its fix", async () => {
    const client = clientFor(
      new ToolInputError("The folder doesn't exist.", "List folders first."),
    );

    const result = await client.callTool("test_fail_always");

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("The folder doesn't exist.\n\nFix: List folders first.");
  });

  it("turns an HttpError into a tool error with a fix for its status", async () => {
    const client = clientFor(new HttpError(404, "The item wasn't found."));

    const result = await client.callTool("test_fail_always");

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/^The item wasn't found\.\n\nFix: Check the identifier/);
  });

  it("logs an UpstreamError without its cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = clientFor(
      new UpstreamError("GitHub", { upstreamStatus: 503, cause: new Error("secret body") }),
    );

    const result = await client.callTool("test_fail_always");

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/^GitHub returned an error\.\n\nFix: Try again later\./);
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
      {
        level: "warn",
        event: "mcp.tool_failed_upstream",
        tool: "test_fail_always",
        login: "tester",
        status: 502,
        service: "GitHub",
        upstreamStatus: 503,
      },
    ]);
    expect(lines.join("\n")).not.toContain("secret body");
  });

  it("hides the message of an unexpected error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = clientFor(new Error("upstream said: secret detail"));

    const result = await client.callTool("test_fail_always");

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("failed because of an internal error");
    expect(resultText(result)).not.toContain("secret detail");
  });
});
