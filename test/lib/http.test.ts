// Tests for `fetchJson`: schema validation of a successful body, and the `UpstreamError` that
// non-2xx responses, timeouts, redirects, bodies that aren't JSON, oversized bodies, and network
// failures produce.
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { UpstreamError } from "#lib/errors.ts";
import { fetchJson } from "#lib/http.ts";

import { useNetwork } from "../helpers/network.ts";

const network = useNetwork();
const schema = z.object({ name: z.string() });
const URL_UNDER_TEST = "https://upstream.example.com/thing";
const ONE_MEGABYTE = 1024 * 1024;

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error: unknown) => error,
  );
}

describe("fetchJson", () => {
  it("returns the body parsed with the schema", async () => {
    network.use(http.get(URL_UNDER_TEST, () => HttpResponse.json({ name: "starter" })));

    await expect(fetchJson(URL_UNDER_TEST, { schema })).resolves.toEqual({ name: "starter" });
  });

  it("throws an UpstreamError with status 502 for a non-2xx response", async () => {
    network.use(http.get(URL_UNDER_TEST, () => new HttpResponse("secret detail", { status: 500 })));

    const error = await failure(fetchJson(URL_UNDER_TEST, { schema }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 502, upstreamStatus: 500, timedOut: false });
    expect(error).toHaveProperty("message", expect.not.stringContaining("secret detail"));
  });

  it("throws an UpstreamError with status 504 when the request times out", async () => {
    network.use(
      http.get(URL_UNDER_TEST, async () => {
        await delay(500);
        return HttpResponse.json({ name: "late" });
      }),
    );

    const error = await failure(fetchJson(URL_UNDER_TEST, { schema, timeoutMs: 20 }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 504, timedOut: true });
  });

  it("throws an UpstreamError with status 502 for a body that isn't JSON", async () => {
    network.use(http.get(URL_UNDER_TEST, () => HttpResponse.text("<html>oops</html>")));

    const error = await failure(fetchJson(URL_UNDER_TEST, { schema }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 502, timedOut: false });
  });

  it("throws an UpstreamError when Content-Length declares more than 1 MB", async () => {
    network.use(
      http.get(
        URL_UNDER_TEST,
        () =>
          new HttpResponse("{}", {
            headers: { "Content-Type": "application/json", "Content-Length": "2000000" },
          }),
      ),
    );

    const error = await failure(fetchJson(URL_UNDER_TEST, { schema }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 502 });
  });

  it("throws an UpstreamError when a body without a length grows past 1 MB", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    network.use(
      http.get(URL_UNDER_TEST, () => {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent > 2 * ONE_MEGABYTE) {
              controller.close();
              return;
            }
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        return new HttpResponse(body, { headers: { "Content-Type": "application/json" } });
      }),
    );

    const error = await failure(fetchJson(URL_UNDER_TEST, { schema }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 502 });
  });

  it("throws an UpstreamError instead of following a redirect", async () => {
    network.use(
      http.get(URL_UNDER_TEST, () =>
        HttpResponse.redirect("https://elsewhere.example.com/thing", 302),
      ),
      http.get("https://elsewhere.example.com/thing", () => HttpResponse.json({ name: "moved" })),
    );

    const error = await failure(fetchJson(URL_UNDER_TEST, { schema }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 502, upstreamStatus: 302 });
  });

  it("throws an UpstreamError with status 502 when the network fails", async () => {
    // No handler matches, so the shared baseline answers with a network error.
    const error = await failure(fetchJson(URL_UNDER_TEST, { schema }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 502, timedOut: false });
  });

  it("rethrows when the caller aborts the request", async () => {
    network.use(
      http.get(URL_UNDER_TEST, async () => {
        await delay(500);
        return HttpResponse.json({ name: "late" });
      }),
    );
    const controller = new AbortController();
    const pending = failure(fetchJson(URL_UNDER_TEST, { schema, signal: controller.signal }));

    controller.abort();
    const error = await pending;

    expect(error).not.toBeInstanceOf(UpstreamError);
  });
});
