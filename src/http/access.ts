// Cloudflare Access identity for the HTTP layer and the web app. It resolves who made a request
// and gates private routes. Whether a site is private is runtime configuration, not code: a public
// site keeps this file and leaves `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` empty, and then every route
// serves without an identity.
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

import { HttpError, UpstreamError } from "#lib/errors.ts";
import { log } from "#lib/log.ts";

/** The signed-in person behind a request, as Cloudflare Access reports them. */
export interface Identity {
  email: string;
  name?: string;
}

/** Hono context variables that `requireIdentity()` sets. */
export interface AccessVariables {
  /** The identity of the request, or `null` when it has none. */
  identity: Identity | null;
}

/** Hono environment for apps and routes that use `requireIdentity()`. */
export interface AccessEnv {
  Bindings: Env;
  Variables: AccessVariables;
}

/** The Access settings of a private site. */
interface AccessConfig {
  /** Team domain without a scheme, such as `myteam.cloudflareaccess.com`. */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  aud: string;
}

/**
 * Returns the Access settings when the site is private, or `null` when it is public. A site is
 * private when both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set. Setting only one throws, so a
 * half-configured site fails closed instead of serving private routes to everyone.
 */
export function accessConfig(env: Env): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/^https:\/\//, "").replace(/\/+$/, "");
  const aud = env.ACCESS_AUD;
  if (teamDomain === "" && aud === "") {
    return null;
  }
  if (teamDomain === "" || aud === "") {
    throw new Error("Set both ACCESS_TEAM_DOMAIN and ACCESS_AUD, or neither.");
  }
  return { teamDomain, aud };
}

// One key set per team domain for the life of the isolate. `jose` caches the keys and refetches
// them when a token names a key it hasn't seen, so key rotation needs no restart.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(teamDomain: string) {
  let keySet = keySets.get(teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keySet);
  }
  return keySet;
}

let warnedUnconfigured = false;

/**
 * Returns whether a private route needs an identity, which is when the site is private. On a
 * public site it returns `false` and logs `access.unconfigured` once per isolate, so a deployment
 * that lost its Access vars shows up in the logs instead of quietly serving private routes to
 * everyone.
 */
export function identityRequired(env: Env): boolean {
  if (accessConfig(env) !== null) {
    return true;
  }
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    log.warn("access.unconfigured");
  }
  return false;
}

// These codes mean that the certificates endpoint failed, not that the token is bad.
const KEY_SET_FAILURES = new Set([
  errors.JOSEError.code,
  errors.JWKSInvalid.code,
  errors.JWKSTimeout.code,
]);

async function identityFromToken(token: string, config: AccessConfig): Promise<Identity | null> {
  try {
    const { payload } = await jwtVerify(token, keySetFor(config.teamDomain), {
      issuer: `https://${config.teamDomain}`,
      audience: config.aud,
      // Access signs application tokens with RS256. Pinning the algorithm rejects a token whose
      // header names another one, such as HS256 keyed with the public key.
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
      // Seconds of clock skew to accept between Access and the Worker.
      clockTolerance: 5,
    });
    // A service token has no `email` claim, so it carries no identity and private routes reject
    // it. To accept service tokens, build an identity from the `common_name` claim here.
    return typeof payload.email === "string" ? { email: payload.email } : null;
  } catch (error) {
    // `jose` lets a failed request for the certificates through unwrapped, so anything that isn't
    // a `JOSEError` means that Access couldn't be reached.
    if (!(error instanceof errors.JOSEError)) {
      throw new UpstreamError("Cloudflare Access", { cause: error });
    }
    if (KEY_SET_FAILURES.has(error.code)) {
      throw new UpstreamError("Cloudflare Access", { cause: error });
    }
    log.warn("access.token_rejected", { reason: error.code });
    return null;
  }
}

// `ctx.access` exists only when Cloudflare Access protects the Worker itself and no static assets
// router sits in front of it, or under `wrangler dev` with `access.dev`. Its absence is normal.
// Hono types its execution context without `access`, so this check reads it from any object.
function isAccessContext(value: unknown): value is CloudflareAccessContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "getIdentity" in value &&
    typeof value.getIdentity === "function"
  );
}

function accessContextOf(ctx: object): CloudflareAccessContext | undefined {
  return "access" in ctx && isAccessContext(ctx.access) ? ctx.access : undefined;
}

/**
 * Resolves the identity of a request. It uses `ctx.access` when the runtime provides it.
 * Otherwise, on a private site, it verifies the `Cf-Access-Jwt-Assertion` header against the
 * team's signing keys. It returns `null` on a public site, and when the token is missing or
 * invalid. `ctx` is the execution context of the request, from Hono or from the Worker entry.
 */
export async function resolveIdentity(
  request: Request,
  env: Env,
  ctx: object,
): Promise<Identity | null> {
  const access = accessContextOf(ctx);
  if (access) {
    const identity = await access.getIdentity();
    if (identity?.email === undefined) {
      return null;
    }
    return identity.name === undefined
      ? { email: identity.email }
      : { email: identity.email, name: identity.name };
  }

  const config = accessConfig(env);
  if (!config) {
    return null;
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  return token ? identityFromToken(token, config) : null;
}

/**
 * Hono middleware that resolves the identity and stores it as the `identity` variable. On a
 * private site, it rejects a request without an identity with a 403 response. On a public site,
 * every request passes and `identity` may be `null`.
 */
export function requireIdentity() {
  return createMiddleware<AccessEnv>(async (c, next) => {
    const required = identityRequired(c.env);
    const identity = await resolveIdentity(c.req.raw, c.env, c.executionCtx);
    if (identity === null && required) {
      throw new HttpError(403, "This route requires a Cloudflare Access identity.");
    }
    c.set("identity", identity);
    await next();
  });
}
