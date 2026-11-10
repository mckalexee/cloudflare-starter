// Tests for the account page and the identity gate that the root route applies to every route
// outside its public list.
import { exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

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

function usePrivateSite() {
  setWebAccess("private");
  setAccessVars(issuer.teamDomain, AUD);
}

describe("GET /account", () => {
  it("renders the public-site note on a public site", async () => {
    setWebAccess("public");
    setAccessVars("", "");

    const response = await exports.default.fetch("http://example.com/account");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("This site is public");
  });

  it("renders the email of a signed-in person on a private site", async () => {
    usePrivateSite();
    const token = await issuer.sign({ email: "ada@example.com" });

    const response = await exports.default.fetch("http://example.com/account", {
      headers: { "cf-access-jwt-assertion": token },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<dd>ada@example.com</dd>");
  });

  it("returns 403 with the gate's message on a private site without an identity", async () => {
    usePrivateSite();

    const response = await exports.default.fetch("http://example.com/account");

    expect(response.status).toBe(403);
    const page = await response.text();
    expect(page).toContain("<h1>403</h1><p>This page requires a Cloudflare Access identity.</p>");
    expect(page).not.toContain("Internal Server Error");
  });

  it("returns 403 for the route's data request on a private site without an identity", async () => {
    usePrivateSite();

    const response = await exports.default.fetch("http://example.com/account.data");

    expect(response.status).toBe(403);
  });
});

describe("GET / on a private site", () => {
  it("renders without an identity, because the home page is public", async () => {
    usePrivateSite();

    const response = await exports.default.fetch("http://example.com/");

    expect(response.status).toBe(200);
  });
});
