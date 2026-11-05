// Tests for the health check route that deploy workflows poll after a release.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const response = await exports.default.fetch("http://example.com/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
