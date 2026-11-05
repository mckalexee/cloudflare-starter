// Tests for the HTTP error handler and the request logger. A test-only Hono app registers routes
// that throw, so production code needs no hooks for failure cases.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleError } from "#http/errors.ts";
import { logRequests } from "#http/logging.ts";
import { HttpError } from "#lib/errors.ts";

function createTestApp() {
  return new Hono()
    .use(logRequests)
    .onError(handleError)
    .get("/teapot", () => {
      throw new HttpError(418, "This server is a teapot.");
    })
    .get("/boom", () => {
      throw new Error("database password is hunter2");
    });
}

function logLines(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleError", () => {
  it("responds to an HttpError with its status and message", async () => {
    const response = await createTestApp().request("/teapot");

    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({ error: { message: "This server is a teapot." } });
  });

  it("logs an unexpected error and responds with a generic 500", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await createTestApp().request("/boom");

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { message: "Internal server error." } });
    expect(text).not.toContain("hunter2");
    expect(logLines(errorLog)).toEqual([
      expect.objectContaining({ event: "http.unhandled_error", method: "GET", path: "/boom" }),
    ]);
  });
});

describe("logRequests", () => {
  it("logs the method, path, status, and duration without the query string", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    await createTestApp().request("/teapot?token=secret");

    const lines = logLines(infoLog);
    expect(lines).toEqual([
      {
        level: "info",
        event: "http.request",
        method: "GET",
        path: "/teapot",
        status: 418,
        durationMs: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });
});
