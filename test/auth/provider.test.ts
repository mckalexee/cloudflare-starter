// Tests for the provider cache, and for how the Worker entry passes `env` to the provider and
// handles a resource URL it can't resolve.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createProviderCache } from "#auth/provider.ts";

import { workerFetch } from "../helpers/oauth.ts";

const defaultHandler = { fetch: () => new Response("default") };

const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

describe("createProviderCache", () => {
  it("reuses one provider per resource", () => {
    const providerFor = createProviderCache(defaultHandler);
    const first = providerFor("https://a.example.com/mcp");

    const other = providerFor("https://b.example.com/mcp");

    expect(other).not.toBe(first);
    expect(providerFor("https://a.example.com/mcp")).toBe(first);
    expect(providerFor("https://b.example.com/mcp")).toBe(other);
  });

  it("replaces the oldest provider when a ninth resource arrives", () => {
    const providerFor = createProviderCache(defaultHandler);
    const oldest = providerFor("https://host-0.example.com/mcp");
    for (let index = 1; index <= 8; index++) {
      providerFor(`https://host-${index}.example.com/mcp`);
    }

    expect(providerFor("https://host-0.example.com/mcp")).not.toBe(oldest);
  });

  it("keeps every other provider when it drops the oldest", () => {
    const providerFor = createProviderCache(defaultHandler);
    providerFor("https://host-0.example.com/mcp");
    const kept = new Map<string, unknown>();
    for (let index = 1; index <= 7; index++) {
      const resource = `https://host-${index}.example.com/mcp`;
      kept.set(resource, providerFor(resource));
    }

    providerFor("https://host-8.example.com/mcp");

    for (const [resource, provider] of kept) {
      expect(providerFor(resource)).toBe(provider);
    }
  });
});

describe("Worker entry", () => {
  it("keeps the provider's helpers off the shared env object", async () => {
    await workerFetch("/authorize?client_id=unknown");

    expect("OAUTH_PROVIDER" in env).toBe(false);
  });

  it("answers 500 with the configuration message when the resource URL can't be resolved", async () => {
    const original = env.MCP_RESOURCE;
    env.MCP_RESOURCE = "";
    try {
      const response = await exports.default.fetch(new Request("https://mcp.example.com/mcp"));

      expect(response.status).toBe(500);
      expect(errorBodySchema.parse(await response.json()).error.message).toContain(
        "MCP_RESOURCE is empty",
      );
    } finally {
      env.MCP_RESOURCE = original;
    }
  });
});
