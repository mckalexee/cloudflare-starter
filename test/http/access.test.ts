// Tests for Cloudflare Access identity: `ctx.access`, verification of the signed JWT header, the
// public-site mode, the 403 gate on `GET /api/me`, and the once-per-isolate warning on a public
// site.
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { identityRequired, resolveIdentity } from "#http/access.ts";

import { type AccessIssuer, AUD, createAccessIssuer, useAccessVars } from "../helpers/access.ts";
import { useNetwork } from "../helpers/network.ts";

const network = useNetwork();
const setAccessVars = useAccessVars();
let issuer: AccessIssuer;

beforeAll(async () => {
  issuer = await createAccessIssuer();
});

beforeEach(() => {
  network.use(issuer.certs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getMe(token?: string) {
  const headers = new Headers();
  if (token !== undefined) {
    headers.set("cf-access-jwt-assertion", token);
  }
  return exports.default.fetch("http://example.com/api/me", { headers });
}

function usePrivateSite() {
  setAccessVars(issuer.teamDomain, AUD);
}

describe("resolveIdentity with ctx.access", () => {
  const request = new Request("http://example.com/");

  it("returns the identity that ctx.access reports", async () => {
    const ctx = {
      access: {
        aud: AUD,
        getIdentity: () => Promise.resolve({ email: "ada@example.com", name: "Ada" }),
      },
    };

    expect(await resolveIdentity(request, env, ctx)).toEqual({
      email: "ada@example.com",
      name: "Ada",
    });
  });

  it("returns null when the ctx.access identity has no email", async () => {
    const ctx = { access: { aud: AUD, getIdentity: () => Promise.resolve(undefined) } };

    expect(await resolveIdentity(request, env, ctx)).toBeNull();
  });

  it("prefers ctx.access over the JWT header", async () => {
    usePrivateSite();
    const headers = { "cf-access-jwt-assertion": "not-a-jwt" };
    const ctx = {
      access: { aud: AUD, getIdentity: () => Promise.resolve({ email: "ada@example.com" }) },
    };

    expect(await resolveIdentity(new Request(request, { headers }), env, ctx)).toEqual({
      email: "ada@example.com",
    });
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

  it("returns 403 for a JWT from another issuer", async () => {
    usePrivateSite();

    const response = await getMe(
      await issuer.sign({ email: "ada@example.com" }, { issuer: "https://evil.example.com" }),
    );

    expect(response.status).toBe(403);
  });

  it("returns 403 for an expired JWT", async () => {
    usePrivateSite();
    // Past the five seconds of clock skew that verification allows.
    const expiresAt = Math.floor(Date.now() / 1000) - 60;

    const response = await getMe(await issuer.sign({ email: "ada@example.com" }, { expiresAt }));

    expect(response.status).toBe(403);
  });

  it("returns 403 for a JWT without an expiration time", async () => {
    usePrivateSite();

    const response = await getMe(
      await issuer.sign({ email: "ada@example.com" }, { expiresAt: null }),
    );

    expect(response.status).toBe(403);
  });

  it("returns 403 for a service token, which has no email", async () => {
    usePrivateSite();

    const response = await getMe(await issuer.sign({ common_name: "ci.access" }));

    expect(response.status).toBe(403);
  });

  it("returns 403 for an HS256 JWT keyed with the published public key", async () => {
    usePrivateSite();

    const response = await getMe(
      await issuer.sign({ email: "ada@example.com" }, { hmacWithPublicKey: true }),
    );

    expect(response.status).toBe(403);
  });

  it("returns 403 for a JWT signed by an unknown key", async () => {
    usePrivateSite();

    const response = await getMe(
      await issuer.sign({ email: "ada@example.com" }, { untrustedKey: true }),
    );

    expect(response.status).toBe(403);
  });

  it("returns 403 without the JWT header", async () => {
    usePrivateSite();

    const response = await getMe();

    expect(response.status).toBe(403);
  });

  it("returns 502 when the Access certificates endpoint fails", async () => {
    const down = await createAccessIssuer();
    setAccessVars(down.teamDomain, AUD);
    network.use(
      http.get(`https://${down.teamDomain}/cdn-cgi/access/certs`, () =>
        HttpResponse.text("unavailable", { status: 503 }),
      ),
    );

    const response = await getMe(await down.sign({ email: "ada@example.com" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: "Cloudflare Access returned an error." },
    });
  });

  it("returns 502 when the Access certificates endpoint can't be reached", async () => {
    // No handler serves this issuer's certificates, so the request fails with a network error.
    const unreachable = await createAccessIssuer();
    setAccessVars(unreachable.teamDomain, AUD);

    const response = await getMe(await unreachable.sign({ email: "ada@example.com" }));

    expect(response.status).toBe(502);
  });
});

describe("GET /api/me on a public site", () => {
  it("returns a null identity", async () => {
    setAccessVars("", "");

    const response = await getMe();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity: null });
  });

  it("returns a null identity even with a valid JWT, because nothing verifies it", async () => {
    setAccessVars("", "");

    const response = await getMe(await issuer.sign({ email: "ada@example.com" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity: null });
  });

  it("returns 500 when only one Access var is set", async () => {
    setAccessVars(issuer.teamDomain, "");

    const response = await getMe();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: "Internal server error." } });
  });
});

describe("identityRequired", () => {
  it("warns once per isolate that Access isn't configured", async () => {
    // A fresh copy of the module, so that a warning from an earlier test can't hide this one.
    vi.resetModules();
    const fresh = await import("#http/access.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const publicEnv = { ...env, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };

    expect(fresh.identityRequired(publicEnv)).toBe(false);
    expect(fresh.identityRequired(publicEnv)).toBe(false);

    const events = warn.mock.calls.map(([line]) => String(line));
    expect(events.filter((line) => line.includes('"access.unconfigured"'))).toHaveLength(1);
  });

  it("is true on a private site", () => {
    expect(
      identityRequired({ ...env, ACCESS_TEAM_DOMAIN: issuer.teamDomain, ACCESS_AUD: AUD }),
    ).toBe(true);
  });
});
