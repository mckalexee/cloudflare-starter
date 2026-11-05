// Tests for `resolveResource`, which picks the URL that OAuth tokens are bound to.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { resolveResource } from "#auth/resource.ts";

describe("resolveResource", () => {
  it.each(["http://localhost:5173", "http://127.0.0.1:8787", "http://[::1]:5173"])(
    "derives the resource from a loopback origin before it reads MCP_RESOURCE: %s",
    (origin) => {
      const request = new Request(`${origin}/authorize`);

      const resource = resolveResource(request, {
        ...env,
        MCP_RESOURCE: "https://mcp.example.com/mcp",
        ENVIRONMENT: "production",
      });

      expect(resource).toBe(`${origin}/mcp`);
    },
  );

  it("returns MCP_RESOURCE when it is set", () => {
    const request = new Request("https://pr-7-starter.example.workers.dev/mcp");

    const resource = resolveResource(request, {
      ...env,
      MCP_RESOURCE: "https://mcp.example.com/mcp",
      ENVIRONMENT: "preview",
    });

    expect(resource).toBe("https://mcp.example.com/mcp");
  });

  it("derives the resource from the origin on a workers.dev Preview", () => {
    const request = new Request("https://pr-7-starter.example.workers.dev/authorize?x=1");

    const resource = resolveResource(request, { ...env, MCP_RESOURCE: "", ENVIRONMENT: "preview" });

    expect(resource).toBe("https://pr-7-starter.example.workers.dev/mcp");
  });

  it("throws an error that names MCP_RESOURCE when it is empty outside a Preview", () => {
    const request = new Request("https://pr-7-starter.example.workers.dev/mcp");

    expect(() =>
      resolveResource(request, { ...env, MCP_RESOURCE: "", ENVIRONMENT: "production" }),
    ).toThrow(/MCP_RESOURCE/);
  });

  it("throws on a Preview that isn't served from workers.dev", () => {
    const request = new Request("https://preview.example.com/mcp");

    expect(() =>
      resolveResource(request, { ...env, MCP_RESOURCE: "", ENVIRONMENT: "preview" }),
    ).toThrow(/MCP_RESOURCE/);
  });
});
