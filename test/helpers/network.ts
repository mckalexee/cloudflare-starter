// Shared MSW setup for test files that make outbound requests. Every request that no handler
// mocks fails with a network error, so a test can never reach the real network, and a missing
// mock shows up as a failure in the code under test instead of a slow or flaky call.
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll } from "vitest";

// MSW tries handlers in order, and `network.use()` puts a test's handlers in front of this one.
const failUnmocked = http.all("*", () => HttpResponse.error());

/** A URL that no test mocks, for proving that an unmocked request fails. */
export const UNMOCKED_URL = "https://unmocked.example.com/";

/**
 * Enables MSW for the test file and returns it. Add handlers in a test with `network.use()`.
 * They're removed after each test, so every test starts from the same baseline.
 */
export function useNetwork(): ReturnType<typeof setupNetwork> {
  const network = setupNetwork();
  // The catch-all handler answers every request, so this applies only when a test replaces it, as
  // `network.resetHandlers(handler)` does. The default `warn` would then let the request reach the
  // real network.
  network.configure({ onUnhandledFrame: "error" });
  beforeAll(() => {
    network.resetHandlers(failUnmocked);
    return network.enable();
  });
  afterEach(() => {
    network.resetHandlers(failUnmocked);
  });
  afterAll(() => network.disable());
  return network;
}
