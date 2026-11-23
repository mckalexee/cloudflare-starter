// Tests that a public-list entry matches the pattern that React Router reports, whether the entry
// is written with a leading slash or without one. The tests bring their own lists, so they hold
// whatever `PUBLIC_PATHS` contains.
import { describe, expect, it } from "vitest";

import { isPublicPath, matchesPublicPath, PUBLIC_PATHS } from "#web/public-paths.ts";

describe("matchesPublicPath", () => {
  it("matches an entry written with a leading slash", () => {
    expect(matchesPublicPath(["/blog/:slug"], "blog/:slug")).toBe(true);
  });

  it("matches an entry written without a leading slash", () => {
    expect(matchesPublicPath(["blog/:slug"], "blog/:slug")).toBe(true);
  });

  it("matches the index route, which React Router reports as /", () => {
    expect(matchesPublicPath(["/"], "/")).toBe(true);
  });

  it("doesn't match the index route through a listed child route", () => {
    expect(matchesPublicPath(["/blog/:slug", "account"], "/")).toBe(false);
  });

  it("doesn't match a child route through the listed index route", () => {
    expect(matchesPublicPath(["/"], "account")).toBe(false);
  });

  it("matches only whole patterns", () => {
    expect(matchesPublicPath(["/blog"], "blog/:slug")).toBe(false);
  });
});

describe("isPublicPath", () => {
  it("checks a pattern against PUBLIC_PATHS", () => {
    for (const pattern of ["/", "account", "blog/:slug", ...PUBLIC_PATHS]) {
      expect(isPublicPath(pattern)).toBe(matchesPublicPath(PUBLIC_PATHS, pattern));
    }
  });
});
