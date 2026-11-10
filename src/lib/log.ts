// Structured logger. Every log line is one JSON object, so Workers Logs can index its fields. This
// is the only module allowed to call `console`.

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const MAX_CAUSE_DEPTH = 3;

function serializeError(error: Error, depth: number): Fields {
  const result: Fields = { name: error.name, message: error.message, stack: error.stack };
  // The depth limit keeps a cyclic `cause` chain from recursing forever.
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    result["cause"] =
      error.cause instanceof Error ? serializeError(error.cause, depth + 1) : error.cause;
  }
  return result;
}

function serializeValue(value: unknown): unknown {
  return value instanceof Error ? serializeError(value, 1) : value;
}

// Errors nested one level deep, such as `{ failures: [error] }` or `{ detail: { error } }`, are
// serialized too, because `JSON.stringify` would otherwise reduce an `Error` to `{}`.
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value, 1);
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, serializeValue(nested)]),
    );
  }
  return value;
}

function write(level: Level, event: string, fields: Fields): void {
  const entry: Fields = { level, event };
  for (const [key, value] of Object.entries(fields)) {
    entry[key] = serialize(value);
  }
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // A circular structure or a BigInt must not turn a log call into a thrown error.
    line = JSON.stringify({ level, event, logError: "unserializable" });
  }
  console[level](line);
}

/**
 * Writes structured log lines. The event is a short, stable name such as `http.unhandled_error`,
 * and the fields carry request-specific detail. Never pass tokens, secrets, cookies, or other
 * credentials.
 */
export const log = {
  debug: (event: string, fields: Fields = {}) => write("debug", event, fields),
  info: (event: string, fields: Fields = {}) => write("info", event, fields),
  warn: (event: string, fields: Fields = {}) => write("warn", event, fields),
  error: (event: string, fields: Fields = {}) => write("error", event, fields),
};
