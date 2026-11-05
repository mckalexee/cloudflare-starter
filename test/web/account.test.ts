// Tests for the account page and the identity gate that the root route applies to every route
// outside its public list.
import { exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

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

describe("GET /account", () => {
  it("renders the public-site note when Access isn't configured", async () => {
    setAccessVars("", "");

    const response = await exports.default.fetch("http://example.com/account");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("This site is public");
  });

  it("renders the email of a signed-in person on a private site", async () => {
    setAccessVars(issuer.teamDomain, AUD);
    const token = await issuer.sign({ email: "ada@example.com" });

    const response = await exports.default.fetch("http://example.com/account", {
      headers: { "cf-access-jwt-assertion": token },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<dd>ada@example.com</dd>");
  });

  it("returns 403 with the gate's message on a private site without an identity", async () => {
    setAccessVars(issuer.teamDomain, AUD);

    const response = await exports.default.fetch("http://example.com/account");

    expect(response.status).toBe(403);
    const page = await response.text();
    expect(page).toContain("<h1>403</h1><p>This page requires a Cloudflare Access identity.</p>");
    expect(page).not.toContain("Internal Server Error");
  });

  it("returns 403 for the route's data request on a private site without an identity", async () => {
    setAccessVars(issuer.teamDomain, AUD);

    const response = await exports.default.fetch("http://example.com/account.data");

    expect(response.status).toBe(403);
  });
});

describe("GET / on a private site", () => {
  it("renders without an identity, because the home page is public", async () => {
    setAccessVars(issuer.teamDomain, AUD);

    const response = await exports.default.fetch("http://example.com/");

    expect(response.status).toBe(200);
  });
});
