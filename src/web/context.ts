// Router contexts that carry Worker state into React Router middleware, loaders, and actions. The
// Hono layer fills them for each request, and route modules read them with `context.get()`.
import { createContext } from "react-router";

import type { Identity } from "#http/access.ts";

/** The bindings and execution context of the request that React Router is rendering. */
export interface CloudflareContext {
  env: Env;
  // Hono's execution context type covers these two methods, so the Hono layer passes its
  // context through without a runtime check.
  ctx: Pick<ExecutionContext, "waitUntil" | "passThroughOnException">;
}

/** Router context that holds the Cloudflare bindings for the current request. */
export const cloudflareContext = createContext<CloudflareContext>();

/**
 * Router context that holds a function that resolves the Cloudflare Access identity of the
 * current request. The first call does the work, and later calls return the same promise. The
 * identity gate calls it on private routes. A public route can call it when a page wants to know
 * who is signed in.
 */
export const identityResolverContext = createContext<() => Promise<Identity | null>>();

/**
 * Router context that holds the Cloudflare Access identity of the current request, or `null` when
 * the request has none. The identity gate in `src/web/middleware.ts` sets it on private routes, so
 * on a public route it's always `null`.
 */
export const identityContext = createContext<Identity | null>(null);
