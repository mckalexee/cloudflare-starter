// Tests for Cloudflare Access identity: the `aud` check on `ctx.access`, verification of the
// signed JWT header, and the behavior with empty or half-set Access vars.
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveIdentity } from "#http/access.ts";
import { UpstreamError } from "#lib/errors.ts";

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
  setAccessVars(issuer.teamDomain, AUD);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function requestWith(token?: string) {
  const headers = new Headers();
  if (token !== undefined) {
    headers.set("cf-access-jwt-assertion", token);
  }
  return new Request("http://example.com/", { headers });
}

function accessContext(aud: string, identity?: { email: string; name?: string }) {
  return { access: { aud, getIdentity: () => Promise.resolve(identity) } };
}

async function resolveToken(token?: string) {
  return resolveIdentity(requestWith(token), env, {});
}

describe("resolveIdentity with ctx.access", () => {
  it("returns the identity that ctx.access reports for the configured application", async () => {
    const ctx = accessContext(AUD, { email: "ada@example.com", name: "Ada" });

    expect(await resolveIdentity(requestWith(), env, ctx)).toEqual({
      email: "ada@example.com",
      name: "Ada",
    });
  });

  it("returns null and logs when ctx.access belongs to another application", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = accessContext("another-app", { email: "ada@example.com" });

    expect(await resolveIdentity(requestWith(), env, ctx)).toBeNull();
    const events = warn.mock.calls.map(([line]) => String(line));
    expect(events.some((line) => line.includes('"aud_mismatch"'))).toBe(true);
  });

  it("returns null when the Access vars are empty, whatever ctx.access reports", async () => {
    setAccessVars("", "");
    const ctx = accessContext(AUD, { email: "ada@example.com" });

    expect(await resolveIdentity(requestWith(), env, ctx)).toBeNull();
  });

  it("returns null when the ctx.access identity has no email", async () => {
    expect(await resolveIdentity(requestWith(), env, accessContext(AUD))).toBeNull();
  });

  it("prefers ctx.access over the JWT header", async () => {
    const ctx = accessContext(AUD, { email: "ada@example.com" });

    expect(await resolveIdentity(requestWith("not-a-jwt"), env, ctx)).toEqual({
      email: "ada@example.com",
    });
  });
});

describe("resolveIdentity with the JWT header", () => {
  it("returns the identity from a valid Access JWT", async () => {
    const token = await issuer.sign({ email: "ada@example.com" });

    expect(await resolveToken(token)).toEqual({ email: "ada@example.com" });
  });

  it("returns null for a JWT with the wrong audience", async () => {
    const token = await issuer.sign({ email: "ada@example.com" }, { audience: "another-app" });

    expect(await resolveToken(token)).toBeNull();
  });

  it("returns null for a JWT from another issuer", async () => {
    const token = await issuer.sign(
      { email: "ada@example.com" },
      { issuer: "https://evil.example.com" },
    );

    expect(await resolveToken(token)).toBeNull();
  });

  it("returns null for an expired JWT", async () => {
    // Past the five seconds of clock skew that verification allows.
    const expiresAt = Math.floor(Date.now() / 1000) - 60;
    const token = await issuer.sign({ email: "ada@example.com" }, { expiresAt });

    expect(await resolveToken(token)).toBeNull();
  });

  it("returns null for a JWT without an expiration time", async () => {
    const token = await issuer.sign({ email: "ada@example.com" }, { expiresAt: null });

    expect(await resolveToken(token)).toBeNull();
  });

  it("returns null for a service token, which has no email", async () => {
    expect(await resolveToken(await issuer.sign({ common_name: "ci.access" }))).toBeNull();
  });

  it("returns null for an HS256 JWT keyed with the published public key", async () => {
    const token = await issuer.sign({ email: "ada@example.com" }, { hmacWithPublicKey: true });

    expect(await resolveToken(token)).toBeNull();
  });

  it("returns null for a JWT signed by an unknown key", async () => {
    const token = await issuer.sign({ email: "ada@example.com" }, { untrustedKey: true });

    expect(await resolveToken(token)).toBeNull();
  });

  it("returns null without the JWT header", async () => {
    expect(await resolveToken()).toBeNull();
  });

  it("returns null when the Access vars are empty, even with a valid JWT", async () => {
    const token = await issuer.sign({ email: "ada@example.com" });
    setAccessVars("", "");

    expect(await resolveToken(token)).toBeNull();
  });

  it("throws when only one Access var is set", async () => {
    setAccessVars(issuer.teamDomain, "");

    await expect(resolveToken()).rejects.toThrow(/Set both ACCESS_TEAM_DOMAIN and ACCESS_AUD/);
  });

  it("throws UpstreamError when the Access certificates endpoint fails", async () => {
    const down = await createAccessIssuer();
    setAccessVars(down.teamDomain, AUD);
    network.use(
      http.get(`https://${down.teamDomain}/cdn-cgi/access/certs`, () =>
        HttpResponse.text("unavailable", { status: 503 }),
      ),
    );

    await expect(resolveToken(await down.sign({ email: "ada@example.com" }))).rejects.toThrow(
      UpstreamError,
    );
  });

  it("throws UpstreamError when the Access certificates endpoint can't be reached", async () => {
    // No handler serves this issuer's certificates, so the request fails with a network error.
    const unreachable = await createAccessIssuer();
    setAccessVars(unreachable.teamDomain, AUD);

    await expect(
      resolveToken(await unreachable.sign({ email: "ada@example.com" })),
    ).rejects.toThrow(UpstreamError);
  });
});
