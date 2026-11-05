// Tests that the Worker server-renders the home page with values from its bindings, sends the
// security headers, and renders the error page for an unknown path.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /", () => {
  it("renders the app name from the Worker vars", async () => {
    const response = await exports.default.fetch("http://example.com/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain(`<h1>${env.APP_NAME}</h1>`);
  });

  it("sends the security headers without a policy that would block hydration", async () => {
    const response = await exports.default.fetch("http://example.com/");

    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBeNull();
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });
});

describe("GET an unknown path", () => {
  it("renders a 404 page with fixed text", async () => {
    const response = await exports.default.fetch("http://example.com/no-such-page");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("This page doesn&#x27;t exist.");
  });
});
