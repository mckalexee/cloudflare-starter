// Server rendering entry for the web app. It streams HTML to browsers and waits for the full
// document when the client is a crawler, because crawlers don't run the streamed scripts. It also
// logs the errors that React Router catches, which would otherwise go to `console.error`.
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import {
  type EntryContext,
  type HandleErrorFunction,
  isRouteErrorResponse,
  ServerRouter,
} from "react-router";

import { log } from "#lib/log.ts";

/** Milliseconds that React Router waits for deferred loader data before it gives up. */
export const streamTimeout = 5_000;

/**
 * Logs an error that a loader, an action, or rendering threw. It skips requests that the client
 * aborted, because their errors come from the cancellation, not from the app.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) {
    return;
  }
  // React Router wraps some errors, such as a missing route, in an error response that keeps the
  // original on a field that its types mark private.
  const cause =
    isRouteErrorResponse(error) && "error" in error && error.error instanceof Error
      ? error.error
      : error;
  log.error("ssr.unhandled_error", { error: cause, path: new URL(request.url).pathname });
};

/** Renders the matched routes to an HTML response. */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  // A HEAD response has no body, so rendering would waste CPU time.
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  let shellRendered = false;
  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      // The extra second lets React flush the timeout fallback before the stream aborts.
      signal: AbortSignal.timeout(streamTimeout + 1_000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors before the shell renders reject this promise, and React Router passes them to
        // `handleError`. Errors after that point happen mid-stream, so this is the only place
        // they surface.
        if (shellRendered) {
          log.error("ssr.stream_error", { error, path: new URL(request.url).pathname });
        }
      },
    },
  );
  shellRendered = true;

  if (isbot(request.headers.get("user-agent") ?? "") || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
