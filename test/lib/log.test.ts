// Tests for the structured logger: the fallback line for values that can't be serialized, and
// error serialization with causes and nested errors.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { log } from "#lib/log.ts";

interface Line {
  [key: string]: unknown;
}

// Returns a reader for the first line written to `console.info`.
function captureInfo(): () => Line {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  return () => {
    const written: unknown = spy.mock.calls[0]?.[0];
    return z.record(z.string(), z.unknown()).parse(JSON.parse(z.string().parse(written)));
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log", () => {
  it("writes one JSON line with the level, event, and fields", () => {
    const line = captureInfo();
    log.info("test.event", { id: 1 });
    expect(line()).toEqual({ level: "info", event: "test.event", id: 1 });
  });

  it("writes a fallback line when the fields can't be serialized", () => {
    const line = captureInfo();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    log.info("test.circular", { circular });
    expect(line()).toEqual({ level: "info", event: "test.circular", logError: "unserializable" });
  });

  it("serializes an error with its cause chain", () => {
    const line = captureInfo();
    const error = new Error("outer", { cause: new TypeError("inner") });
    log.info("test.error", { error });
    const written = line();
    expect(written["error"]).toMatchObject({
      name: "Error",
      message: "outer",
      cause: { name: "TypeError", message: "inner" },
    });
  });

  it("stops following causes after three levels", () => {
    const line = captureInfo();
    const error = new Error("0", {
      cause: new Error("1", { cause: new Error("2", { cause: new Error("3") }) }),
    });
    log.info("test.depth", { error });
    expect(line()["error"]).toMatchObject({ cause: { cause: { message: "2" } } });
    expect(line()["error"]).not.toHaveProperty("cause.cause.cause");
  });

  it("serializes errors nested one level deep in a field", () => {
    const line = captureInfo();
    log.info("test.nested", { detail: { error: new Error("nested") }, failures: [new Error("a")] });
    const written = line();
    expect(written["detail"]).toMatchObject({ error: { name: "Error", message: "nested" } });
    expect(written["failures"]).toMatchObject([{ name: "Error", message: "a" }]);
  });
});
