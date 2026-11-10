// Tests for the health check route that deploy workflows poll after a release, and for the
// `Cross-Origin-Opener-Policy` header, which every response carries the same way.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const response = await exports.default.fetch("http://example.com/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("sends Cross-Origin-Opener-Policy unless a popup needs window.opener", async () => {
    const response = await exports.default.fetch("http://example.com/healthz");

    // @starter:oauth
    // The consent page can run in a popup that reports back through `window.opener`.
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBeNull();
    // @starter:end
  });
});
