// Test stand-ins for Cloudflare Access. A test issuer signs application tokens with its own RS256
// key, as Access does, and serves the public key through MSW at the team's certificates URL, so
// the Worker verifies tokens exactly as it does in production.
import { env } from "cloudflare:workers";
import { exportJWK, exportSPKI, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { http, HttpResponse, type HttpHandler } from "msw";
import { afterEach } from "vitest";

/** Application Audience (AUD) tag that tests configure for the Access application. */
export const AUD = "starter-test-aud";

const KEY_ID = "starter-test-key";

/** Options for `AccessIssuer.sign`. */
export interface SignOptions {
  /** Audience claim. Defaults to `AUD`. */
  audience?: string;
  /** Issuer claim. Defaults to the issuer's team domain as an `https` URL. */
  issuer?: string;
  /**
   * Expiration time in seconds since the epoch. Defaults to five minutes from now. `null` leaves
   * the claim out.
   */
  expiresAt?: number | null;
  /** Signs with a key that the certificates endpoint doesn't publish, under the same key ID. */
  untrustedKey?: boolean;
  /**
   * Signs with HS256, using the issuer's published public key as the HMAC secret. A verifier that
   * trusts the token's `alg` header would accept the result.
   */
  hmacWithPublicKey?: boolean;
}

/** A fake Access issuer for one team domain. */
export interface AccessIssuer {
  /** The issuer's team domain, without a scheme. */
  teamDomain: string;
  /** MSW handler that serves the issuer's public key at the team's certificates URL. */
  certs: HttpHandler;
  /** Signs an application token with the given claims. */
  sign(claims: JWTPayload, options?: SignOptions): Promise<string>;
}

/**
 * Creates an issuer with a fresh RS256 key pair. Each issuer gets its own random team domain, and
 * the Worker caches signing keys per team domain for the life of the isolate, so no test can
 * reuse keys that another test's issuer published.
 */
export async function createAccessIssuer(): Promise<AccessIssuer> {
  const teamDomain = `${crypto.randomUUID()}.cloudflareaccess.com`;
  const trusted = await generateKeyPair("RS256", { extractable: true });
  const untrusted = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(trusted.publicKey)), kid: KEY_ID, alg: "RS256" };
  const publicPem = new TextEncoder().encode(await exportSPKI(trusted.publicKey));

  return {
    teamDomain,
    certs: http.get(`https://${teamDomain}/cdn-cgi/access/certs`, () =>
      HttpResponse.json({ keys: [publicJwk] }),
    ),
    sign: (claims, options = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: options.hmacWithPublicKey ? "HS256" : "RS256", kid: KEY_ID })
        .setIssuer(options.issuer ?? `https://${teamDomain}`)
        .setAudience(options.audience ?? AUD)
        .setIssuedAt(now);
      if (options.expiresAt !== null) {
        jwt.setExpirationTime(options.expiresAt ?? now + 300);
      }
      if (options.hmacWithPublicKey) {
        return jwt.sign(publicPem);
      }
      return jwt.sign(options.untrustedKey ? untrusted.privateKey : trusted.privateKey);
    },
  };
}

/**
 * Lets a test file change the Access vars. The Worker under test reads the same `env` object
 * that `cloudflare:workers` exports, so an assignment reaches it. The hook restores the values
 * from `wrangler.jsonc` after each test.
 */
export function useAccessVars(): (teamDomain: string, aud: string) => void {
  const original = { ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN, ACCESS_AUD: env.ACCESS_AUD };
  afterEach(() => {
    Object.assign(env, original);
  });
  return (teamDomain, aud) => {
    env.ACCESS_TEAM_DOMAIN = teamDomain;
    env.ACCESS_AUD = aud;
  };
}

// @starter:web
/**
 * Lets a test file change `WEB_ACCESS`, the same way as `useAccessVars()`. The hook restores the
 * value from `wrangler.jsonc` after each test.
 */
export function useWebAccess(): (value: string) => void {
  const original = env.WEB_ACCESS;
  afterEach(() => {
    env.WEB_ACCESS = original;
  });
  return (value) => {
    env.WEB_ACCESS = value;
  };
}
// @starter:end
