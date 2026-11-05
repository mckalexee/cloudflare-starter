// Resolves the resource URL for a request: the URL of the MCP endpoint that OAuth tokens are bound
// to. The OAuth provider writes this URL into every token as its audience and accepts a token only
// at the resource it names, so a token issued for one deployment can't be replayed against
// another. It must equal the URL that MCP clients connect to, or no client can complete sign-in.
import { MCP_ROUTE } from "#mcp/handler.ts";

// Hostnames that only a request from the same machine can use. The URL parser keeps the brackets
// around an IPv6 address, so `::1` appears as `[::1]`.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Returns the resource URL for a request. On a loopback hostname, such as `localhost` under
 * `pnpm dev`, it's derived from the request's origin, so local sign-in works on whatever origin
 * the dev server answers. A deployed Worker never sees a loopback hostname. Otherwise it's
 * `MCP_RESOURCE` when that var is set. A Preview has no fixed hostname, so with `ENVIRONMENT` set
 * to `preview` and an empty `MCP_RESOURCE`, the URL is derived from the request's `workers.dev`
 * origin. Anything else throws, because a missing resource URL is a configuration error that would
 * otherwise surface as failed sign-ins.
 */
export function resolveResource(request: Request, env: Env): string {
  const url = new URL(request.url);
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return `${url.origin}${MCP_ROUTE}`;
  }
  if (env.MCP_RESOURCE !== "") {
    return env.MCP_RESOURCE;
  }
  // Only `workers.dev` hostnames are derived, because Cloudflare routes those by hostname, so the
  // request URL names the Preview that received it.
  if (env.ENVIRONMENT === "preview" && url.hostname.endsWith(".workers.dev")) {
    return `${url.origin}${MCP_ROUTE}`;
  }
  throw new Error(
    "MCP_RESOURCE is empty. Set it to the URL that MCP clients use, such as " +
      "https://example.com/mcp. Only a Preview on workers.dev may leave it empty.",
  );
}
