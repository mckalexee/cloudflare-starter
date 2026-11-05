// Request logging for the Hono app. Each request produces one `http.request` line with the
// method, path, status, and duration, which is enough to find slow or failing routes in Workers
// Logs.
import type { MiddlewareHandler } from "hono";

import { log } from "#lib/log.ts";

/**
 * Logs one `http.request` event after the response is ready. It logs the path without the query
 * string, and never logs headers, because both can carry credentials.
 */
export const logRequests: MiddlewareHandler = async (c, next) => {
  // Workers advance the clock only during I/O, so the duration measures time spent waiting on
  // subrequests and streams, not CPU time.
  const start = Date.now();
  await next();
  log.info("http.request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - start,
  });
};
