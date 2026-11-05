// Outbound HTTP helper. It gives every upstream call a timeout and a size limit, turns failures
// into `UpstreamError`, and validates the response body, so callers handle one error type and get
// a typed result.
import { UpstreamError } from "#lib/errors.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

// A JSON API response this large is a mistake or an attack. Reading it whole would spend the
// Worker's memory and CPU time before the schema could reject it.
const MAX_BODY_BYTES = 1024 * 1024;

/** Options for `fetchJson`. Every `RequestInit` field passes through to `fetch`. */
export interface FetchJsonOptions<T> extends RequestInit {
  /**
   * Validates the parsed body and returns it with a type. A Zod schema fits this shape. A body
   * that fails validation throws the validator's error, which the edge reports as a 500 response.
   */
  schema: { parse(value: unknown): T };
  /** Milliseconds to wait for the response and its body. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Name of the upstream service in error messages. Defaults to the host of the URL. */
  service?: string;
}

/**
 * Fetches a URL and returns its JSON body after validating it with `schema`. Throws
 * `UpstreamError` when the request fails, the status isn't 2xx, the body is larger than 1 MB or
 * isn't JSON, or the response doesn't arrive in time. A redirect also counts as a failure,
 * because a JSON API that redirects has moved or is misconfigured. Pass `redirect: "follow"` when
 * an API redirects on purpose.
 */
export async function fetchJson<T>(url: string | URL, options: FetchJsonOptions<T>): Promise<T> {
  const {
    schema,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    service = new URL(url).host,
    signal,
    // Workers reject `redirect: "error"`, so a redirect comes back as a 3xx response, which the
    // status check turns into an `UpstreamError`.
    redirect = "manual",
    ...init
  } = options;
  const timeout = AbortSignal.timeout(timeoutMs);

  let body: unknown;
  try {
    const response = await fetch(url, {
      ...init,
      redirect,
      // Keep the caller's signal working alongside the timeout.
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      // The body is never read, so release it instead of holding the connection open.
      await response.body?.cancel();
      throw new UpstreamError(service, { upstreamStatus: response.status });
    }
    body = JSON.parse(await readLimitedText(response));
  } catch (error) {
    if (error instanceof UpstreamError) {
      throw error;
    }
    if (timeout.aborted) {
      throw new UpstreamError(service, { timedOut: true, cause: error });
    }
    // The caller cancelled the request, so the failure is theirs to handle.
    if (signal?.aborted === true) {
      throw error;
    }
    throw new UpstreamError(service, { cause: error });
  }
  return schema.parse(body);
}

// The `Content-Length` check rejects an honest large response without reading it. The counting
// stream catches a body that has no length or lies about it, and stops the read at the limit.
async function readLimitedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error(`The response declares ${declared} bytes, more than ${MAX_BODY_BYTES}.`);
  }
  if (response.body === null) {
    return "";
  }

  let size = 0;
  const limited = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) {
          controller.error(new Error(`The response body is larger than ${MAX_BODY_BYTES} bytes.`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited).text();
}
