// Typed errors that carry what an edge needs to respond. Code that detects a problem throws one of
// these, and the Hono error handler or the MCP tool wrapper turns it into a response.

/**
 * An error with an HTTP status and a message that is safe to show to the client. The Hono error
 * handler responds with this status and message, and the MCP tool wrapper returns the message as
 * a tool error.
 */
export class HttpError extends Error {
  /** HTTP status code to respond with. */
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Details about a failed upstream request, for logs and for choosing the response status. */
export interface UpstreamErrorOptions extends ErrorOptions {
  /** HTTP status that the upstream service returned, when a response arrived. */
  upstreamStatus?: number;
  /** Whether the request ran out of time before a response arrived. */
  timedOut?: boolean;
}

/**
 * A request to another service failed or timed out. The client gets a 502 or 504 response that
 * names the service, and never the upstream response body, which can contain internal detail.
 */
export class UpstreamError extends HttpError {
  /** Name of the upstream service, such as its host name. */
  readonly service: string;
  /** HTTP status that the upstream service returned, or `undefined` when no response arrived. */
  readonly upstreamStatus: number | undefined;
  /** Whether the request ran out of time before a response arrived. */
  readonly timedOut: boolean;

  constructor(service: string, options: UpstreamErrorOptions = {}) {
    const timedOut = options.timedOut ?? false;
    super(
      timedOut ? 504 : 502,
      timedOut ? `${service} didn't respond in time.` : `${service} returned an error.`,
      options,
    );
    this.name = "UpstreamError";
    this.service = service;
    this.upstreamStatus = options.upstreamStatus;
    this.timedOut = timedOut;
  }
}
