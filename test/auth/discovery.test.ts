// Tests for OAuth discovery: the two metadata documents and the 401 challenge on `/mcp`, which
// together let an MCP client find the authorization server with no configuration.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ORIGIN, RESOURCE, workerFetch } from "../helpers/oauth.ts";

const resourceMetadataSchema = z.looseObject({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
});

const serverMetadataSchema = z.looseObject({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  scopes_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
});

describe("protected resource metadata", () => {
  it("is served at the path-suffixed URL and names the resource and its issuer", async () => {
    const response = await workerFetch("/.well-known/oauth-protected-resource/mcp");

    expect(response.status).toBe(200);
    const metadata = resourceMetadataSchema.parse(await response.json());
    expect(metadata.resource).toBe(RESOURCE);
    expect(metadata.authorization_servers).toEqual([ORIGIN]);
  });

  // RFC 9728 builds the metadata URL from the resource, so a resource at `/mcp` has no document at
  // the bare well-known path.
  it("isn't served at the bare well-known path", async () => {
    const response = await workerFetch("/.well-known/oauth-protected-resource");

    expect(response.status).toBe(404);
  });
});

describe("authorization server metadata", () => {
  it("lists the endpoints, the supported scopes, and S256 PKCE", async () => {
    const response = await workerFetch("/.well-known/oauth-authorization-server");

    expect(response.status).toBe(200);
    const metadata = serverMetadataSchema.parse(await response.json());
    expect(metadata).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      scopes_supported: ["profile"],
    });
    expect(metadata.code_challenge_methods_supported).toContain("S256");
  });
});

describe("POST /mcp without a token", () => {
  it("answers 401 with a challenge that points at the resource metadata", async () => {
    const response = await workerFetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});
