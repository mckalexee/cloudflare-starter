// Tests for the private-site rule: `identityRequired()` and `WEB_ACCESS`, and the 403 gate that
// `requireIdentity()` puts on `GET /api/me`.
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { identityRequired } from "#http/access.ts";

import {
  type AccessIssuer,
  AUD,
  createAccessIssuer,
  useAccessVars,
  useWebAccess,
} from "../helpers/access.ts";
import { useNetwork } from "../helpers/network.ts";

const network = useNetwork();
const setAccessVars = useAccessVars();
const setWebAccess = useWebAccess();
let issuer: AccessIssuer;

beforeAll(async () => {
  issuer = await createAccessIssuer();
});

beforeEach(() => {
  network.use(issuer.certs);
});

function getMe(token?: string) {
  const headers = new Headers();
  if (token !== undefined) {
    headers.set("cf-access-jwt-assertion", token);
  }
  return exports.default.fetch("http://example.com/api/me", { headers });
}

function usePrivateSite() {
  setWebAccess("private");
  setAccessVars(issuer.teamDomain, AUD);
}

describe("identityRequired", () => {
  const accessVars = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: AUD };

  it("is false for a public site, even with the Access vars set", () => {
    expect(identityRequired({ ...env, ...accessVars, WEB_ACCESS: "public" })).toBe(false);
  });

  it("is true for a private site with the Access vars set", () => {
    expect(identityRequired({ ...env, ...accessVars, WEB_ACCESS: "private" })).toBe(true);
  });

  it("throws for a private site without the Access vars", () => {
    const privateEnv = { ...env, WEB_ACCESS: "private", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };

    expect(() => identityRequired(privateEnv)).toThrow(/WEB_ACCESS is private/);
  });

  it("throws for a value other than public or private", () => {
    expect(() => identityRequired({ ...env, ...accessVars, WEB_ACCESS: "Private" })).toThrow(
      /WEB_ACCESS must be "public" or "private"/,
    );
  });
});

describe("GET /api/me on a private site", () => {
  it("returns the identity from a valid Access JWT", async () => {
    usePrivateSite();

    const response = await getMe(await issuer.sign({ email: "ada@example.com" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity: { email: "ada@example.com" } });
  });

  it("returns 403 for a JWT with the wrong audience", async () => {
    usePrivateSite();

    const response = await getMe(
      await issuer.sign({ email: "ada@example.com" }, { audience: "another-app" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { message: "This route requires a Cloudflare Access identity." },
    });
  });

  it("returns 403 without the JWT header", async () => {
    usePrivateSite();

    const response = await getMe();

    expect(response.status).toBe(403);
  });

  it("returns 500 without the Access vars, so the site fails closed", async () => {
    setWebAccess("private");
    setAccessVars("", "");

    const response = await getMe();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: "Internal server error." } });
  });

  it("returns 502 when the Access certificates endpoint can't be reached", async () => {
    // No handler serves this issuer's certificates, so the request fails with a network error.
    const unreachable = await createAccessIssuer();
    setWebAccess("private");
    setAccessVars(unreachable.teamDomain, AUD);

    const response = await getMe(await unreachable.sign({ email: "ada@example.com" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: "Cloudflare Access returned an error." },
    });
  });
});

describe("GET /api/me on a public site", () => {
  it("returns a null identity without the Access vars", async () => {
    setWebAccess("public");
    setAccessVars("", "");

    const response = await getMe();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity: null });
  });

  it("returns the identity when Access forwards one, without requiring it", async () => {
    setWebAccess("public");
    setAccessVars(issuer.teamDomain, AUD);

    const signedIn = await getMe(await issuer.sign({ email: "ada@example.com" }));
    const anonymous = await getMe();

    expect(await signedIn.json()).toEqual({ identity: { email: "ada@example.com" } });
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ identity: null });
  });
});
