// A small MCP client for tests. It speaks JSON-RPC over the Streamable HTTP transport to any
// fetch-shaped function, so a test can call the real MCP handler in workerd without a network or
// an SDK client. It uses the 2025-era protocol that most MCP clients send today.
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
// @starter:oauth
import { exports } from "cloudflare:workers";
// @starter:end
import { z } from "zod";

// @starter:oauth
import { RESOURCE } from "./oauth.ts";
// @starter:end

/** Any function that answers a `Request`, such as a Worker handler bound to its `env` and `ctx`. */
export type McpFetch = (request: Request) => Promise<Response>;

/** Options for `createMcpClient`. */
export type McpClientOptions = {
  /** The endpoint URL. The default uses `localhost`, which passes the handler's Host check. */
  url?: string;
  /** Extra headers for every request, such as `Authorization`. */
  headers?: Record<string, string>;
};

/** A JSON-RPC error response from the server, with its code and message. */
export class JsonRpcError extends Error {
  override readonly name = "JsonRpcError";
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const responseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

// The results are checked against the fields the tests read, so a malformed response fails with a
// clear message. Loose objects keep the fields that these schemas don't name.
const initializeResultSchema = z.looseObject({
  protocolVersion: z.string(),
  serverInfo: z.looseObject({ name: z.string(), version: z.string() }),
  instructions: z.string().optional(),
});

const listToolsResultSchema = z.looseObject({
  tools: z.array(
    z.looseObject({
      name: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      inputSchema: z.looseObject({}),
      outputSchema: z.looseObject({}).optional(),
      annotations: z
        .looseObject({
          readOnlyHint: z.boolean().optional(),
          destructiveHint: z.boolean().optional(),
          idempotentHint: z.boolean().optional(),
          openWorldHint: z.boolean().optional(),
        })
        .optional(),
    }),
  ),
});

const callToolResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

/** A `tools/call` result, with the fields that the tests read. */
export type ToolResult = z.infer<typeof callToolResultSchema>;

/**
 * Creates a client with one method per MCP request that the tests use. Each method sends one
 * POST, reads a JSON or Server-Sent Events body, and returns the checked `result`. A JSON-RPC error
 * throws `JsonRpcError`, and a non-2xx HTTP status throws an `Error` with the body.
 */
export function createMcpClient(fetcher: McpFetch, options: McpClientOptions = {}) {
  const url = options.url ?? "http://localhost/mcp";
  let nextId = 1;

  /** Sends a raw JSON-RPC request and returns the HTTP response unread. */
  function post(method: string, params: Record<string, unknown> = {}): Promise<Response> {
    return fetcher(
      new Request(url, {
        method: "POST",
        headers: {
          // A `Request` built in code has no Host header, and the handler rejects a request
          // without one, so the helper sets it the way a network client would.
          Host: new URL(url).host,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
          ...options.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      }),
    );
  }

  async function request<Schema extends z.ZodType>(
    method: string,
    params: Record<string, unknown>,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const response = await post(method, params);
    if (!response.ok) {
      throw new Error(`${method} returned HTTP ${response.status}: ${await response.text()}`);
    }
    const message = responseSchema.parse(await readMessage(response));
    if (message.error !== undefined) {
      throw new JsonRpcError(message.error.code, message.error.message);
    }
    return schema.parse(message.result);
  }

  return {
    post,
    initialize: () =>
      request(
        "initialize",
        {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
        initializeResultSchema,
      ),
    listTools: () => request("tools/list", {}, listToolsResultSchema),
    callTool: (name: string, args: Record<string, unknown> = {}) =>
      request("tools/call", { name, arguments: args }, callToolResultSchema),
  };
}

// @starter:oauth
/**
 * Creates a client that calls `/mcp` through the Worker entry with an OAuth access token, so the
 * OAuth provider validates the token and sets the caller's props before the MCP handler runs. Mint
 * the token through the real flow with `mintAccessToken()` from `oauth.ts`.
 */
export function createOAuthMcpClient(accessToken: string) {
  return createMcpClient((request) => exports.default.fetch(request), {
    url: RESOURCE,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
// @starter:end

// The transport answers with either a JSON body or an SSE stream whose `data:` lines carry the
// JSON-RPC messages. Notifications such as progress can come first, so the response is the
// message that carries an `id`.
async function readMessage(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!(response.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const messages = body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n"),
    )
    .filter((data) => data !== "")
    .map((data): unknown => JSON.parse(data));
  const reply = messages.find(
    (message) => typeof message === "object" && message !== null && "id" in message,
  );
  if (reply === undefined) {
    throw new Error("The SSE response contained no JSON-RPC response.");
  }
  return reply;
}

/** Returns the text of the first content block in a tool result, or fails the test. */
export function resultText(result: ToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text" || block.text === undefined) {
    throw new Error("Expected the tool result to start with a text block.");
  }
  return block.text;
}
