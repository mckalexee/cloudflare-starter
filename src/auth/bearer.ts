// Bearer mode: the single-user alternative to OAuth. The MCP endpoint accepts one static
// token from the `MCP_BEARER_TOKEN` secret and treats every request that presents it as the
// owner.
import { SCOPES, type AuthProps } from "#env.ts";
import { log } from "#lib/log.ts";
import { createMcpApiHandler } from "#mcp/handler.ts";

/** The bindings bearer mode reads, on top of the generated `Env`. */
export type BearerEnv = Env & { MCP_BEARER_TOKEN?: string };

/** Options for `createBearerHandler`. */
export type BearerHandlerOptions = {
  /** A token that replaces `MCP_BEARER_TOKEN`. Tests use it, because they have no secret. */
  token?: string;
};

// The token holder is the only user, so it gets every scope. It has no GitHub account, so its ID
// is `0`, which no GitHub account uses.
const OWNER: AuthProps = { id: 0, login: "owner", name: "Owner", scopes: [...SCOPES] };

let warnedMissingToken = false;

/**
 * Creates a Worker-shaped handler that checks the bearer token and then serves MCP as the owner.
 * A missing or wrong token gets a 401 response with a `WWW-Authenticate: Bearer` challenge.
 */
export function createBearerHandler(options: BearerHandlerOptions = {}) {
  const mcp = createMcpApiHandler({ authContext: { props: OWNER } });

  return {
    async fetch(request: Request, env: BearerEnv, ctx: ExecutionContext): Promise<Response> {
      // Browsers send CORS preflight requests without credentials, so the MCP handler answers
      // them before the token check.
      if (request.method === "OPTIONS") {
        return mcp(request, env, ctx);
      }
      // A secret pasted or piped into `wrangler secret put` can end with a newline.
      const expected = (options.token ?? env.MCP_BEARER_TOKEN)?.trim();
      if (expected === undefined || expected === "") {
        // Every request fails the same way until the secret is set, so one line per isolate is
        // enough to find the cause.
        if (!warnedMissingToken) {
          warnedMissingToken = true;
          log.error("auth.bearer_token_missing");
        }
        return unauthorized();
      }
      const presented = parseBearer(request.headers.get("Authorization"));
      if (presented === undefined || !(await tokensMatch(presented, expected))) {
        return unauthorized();
      }
      return mcp(request, env, ctx);
    },
  };
}

/** The bearer-token handler for production, which reads the token from `MCP_BEARER_TOKEN`. */
export const bearerHandler = createBearerHandler();

function parseBearer(header: string | null): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}

// `timingSafeEqual` needs inputs of equal length, and comparing lengths first would leak the
// token's length. Hashing both values gives two 32-byte digests to compare in constant time.
async function tokensMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const subtle = crypto.subtle;
  if (!hasTimingSafeEqual(subtle)) {
    throw new Error("crypto.subtle.timingSafeEqual is unavailable in this runtime.");
  }
  return subtle.timingSafeEqual(a, b);
}

// The DOM library in `tsconfig.json` types `crypto.subtle` without the Workers-only
// `timingSafeEqual` method. This guard proves that the method exists without a cast.
function hasTimingSafeEqual(subtle: SubtleCrypto): subtle is SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
} {
  return "timingSafeEqual" in subtle;
}

// The CORS headers match the MCP handler's defaults, so a browser-based client can read the 401
// and its challenge. Allowing every origin is safe here, because the token travels in the
// `Authorization` header, which a page can send only when it already holds the token. Browsers
// never attach it on their own the way they attach cookies.
function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": "Bearer",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "WWW-Authenticate",
    },
  });
}
