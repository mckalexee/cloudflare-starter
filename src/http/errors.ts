// Error handler for the Hono app. It is the HTTP edge where typed errors become responses, so
// route handlers throw instead of building error responses themselves.
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { HttpError, UpstreamError } from "#lib/errors.ts";
import { log } from "#lib/log.ts";

/** Body of every error response from the HTTP layer. */
export interface ErrorBody {
  error: { message: string };
}

function errorResponse(status: number, message: string): Response {
  const body: ErrorBody = { error: { message } };
  return Response.json(body, { status });
}

/**
 * Maps a thrown error to a JSON response. An `HttpError` keeps its status and message. Anything
 * else is logged and becomes a generic 500 response, so the client never sees internal detail.
 */
export const handleError: ErrorHandler = (error, c) => {
  const fields = { method: c.req.method, path: c.req.path };

  if (error instanceof UpstreamError) {
    log.warn("http.upstream_error", {
      ...fields,
      service: error.service,
      upstreamStatus: error.upstreamStatus,
      timedOut: error.timedOut,
    });
  }
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.message);
  }
  // Hono's own middleware throws `HTTPException`, which already carries its response.
  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  log.error("http.unhandled_error", { ...fields, error });
  return errorResponse(500, "Internal server error.");
};
