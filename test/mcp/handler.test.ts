// Tests for the MCP handler wrapper: how `resolveAuthProps` checks the props and picks the scopes,
// and how the handler reports an error that escapes the server factory.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpApiHandler, resolveAuthProps } from "#mcp/handler.ts";

import { createMcpClient } from "../helpers/mcp.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAuthProps", () => {
  it("throws when the props don't match the expected shape", () => {
    expect(() => resolveAuthProps(undefined, { id: "1", login: "ada" })).toThrow(
      /no valid auth props/,
    );
    expect(() => resolveAuthProps(undefined, undefined)).toThrow(/no valid auth props/);
  });

  it("throws when the props have no account ID as text", () => {
    expect(() => resolveAuthProps(undefined, { login: "ada", name: "Ada" })).toThrow(
      /no valid auth props/,
    );
    expect(() => resolveAuthProps(undefined, { id: 1, login: "ada", name: "Ada" })).toThrow(
      /no valid auth props/,
    );
  });

  it("uses the token's scopes over the scopes in the props", () => {
    const props = { id: "1", login: "ada", name: "Ada", scopes: ["profile", "admin"] };

    expect(resolveAuthProps([], props).scopes).toEqual([]);
    expect(resolveAuthProps(["profile"], props).scopes).toEqual(["profile"]);
  });

  it("falls back to the scopes in the props when the token has none", () => {
    const props = { id: "1", login: "ada", name: "Ada", scopes: ["profile"] };

    expect(resolveAuthProps(undefined, props).scopes).toEqual(["profile"]);
    expect(resolveAuthProps(undefined, { id: "1", login: "ada", name: "Ada" }).scopes).toEqual([]);
  });

  it("drops fields that the schema doesn't name", () => {
    const props = {
      id: "1",
      login: "ada",
      name: "Ada",
      accessToken: "gho_x",
      refreshToken: "ghr_x",
    };

    expect(resolveAuthProps(["profile"], props)).toEqual({
      id: "1",
      login: "ada",
      name: "Ada",
      scopes: ["profile"],
      accessToken: "gho_x",
    });
  });
});

describe("createMcpApiHandler", () => {
  it("logs mcp.handler_error and answers with a generic error when the props are invalid", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createMcpApiHandler({ authContext: { props: { login: "no-name" } } });
    const client = createMcpClient((request) => handler(request, env, createExecutionContext()));

    const response = await client.post("tools/list");

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("auth props");
    const events = errorLog.mock.calls.map(([line]) => String(line));
    expect(events.some((line) => line.includes('"mcp.handler_error"'))).toBe(true);
  });
});
