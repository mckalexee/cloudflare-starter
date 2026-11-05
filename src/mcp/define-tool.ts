// The one way to declare an MCP tool in this server. A tool module calls `defineTool` with its
// name, schemas, and handler, and gets back a registration that `createServer` runs for each
// request. The wrapper keeps the cross-cutting rules in one place: honest annotations, the scope
// check, result serialization, and the mapping from typed errors to tool errors.
import {
  type CallToolResult,
  type McpServer,
  ProtocolError,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { AuthProps, Scope } from "#env.ts";
import { HttpError, UpstreamError } from "#lib/errors.ts";
import { log } from "#lib/log.ts";
import { ToolInputError } from "#mcp/errors.ts";

/** What a tool handler receives besides its input: the Worker bindings and the signed-in caller. */
export type ToolContext = {
  env: Env;
  props: AuthProps;
};

/**
 * A declared tool: its name and title, which the server instructions list, and the function that
 * registers it on a server built for the current request.
 */
export type ToolRegistration = {
  name: string;
  title: string;
  register: (server: McpServer, context: ToolContext) => void;
};

/**
 * What a tool does to data, which sets its MCP annotations. Use `read` for a tool that only reads,
 * `write` for one that adds or changes data without deleting it, and `destructive` for one that
 * deletes or overwrites data.
 */
export type ToolEffect = "read" | "write" | "destructive";

// Clients use these hints to decide when to ask the user for confirmation, so each one states
// what the tool can do. Only `read` is idempotent, because a write shorthand can't promise that
// repeating a call leaves the same state.
const EFFECT_HINTS: Record<ToolEffect, Omit<ToolAnnotations, "openWorldHint">> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

type HandlerResult<Output> = Output extends z.ZodObject ? z.infer<Output> : unknown;

/**
 * Everything that describes a tool. Write the name as `<area>_<verb>_<noun>` and the description
 * for an agent that has never seen the system behind the tool: when to call it, what the inputs
 * mean, what it changes, and what it returns. Set `openWorld` when the tool reaches people or
 * systems outside this server, such as sending a message or calling a public API. When `output` is
 * set, the handler must return an object that matches it, and clients receive that object as
 * structured content.
 */
export type ToolSpec<Input extends z.ZodObject, Output extends z.ZodObject | undefined> = {
  name: string;
  title: string;
  description: string;
  scope?: Scope;
  effect: ToolEffect;
  openWorld?: boolean;
  input: Input;
  output?: Output;
  handler: (input: z.infer<Input>, context: ToolContext) => Promise<HandlerResult<Output>>;
};

/**
 * Declares a tool and returns its registration. The registered handler checks the declared scope
 * against the caller's scopes, runs your handler, and returns the result as pretty-printed JSON
 * text. A `ToolInputError` or an `HttpError` becomes a tool error whose text tells the agent how to
 * fix the call. Any other error is logged and reported as a generic tool error, so internal
 * details never reach the client.
 */
export function defineTool<
  Input extends z.ZodObject,
  Output extends z.ZodObject | undefined = undefined,
>(spec: ToolSpec<Input, Output>): ToolRegistration {
  const annotations: ToolAnnotations = {
    ...EFFECT_HINTS[spec.effect],
    openWorldHint: spec.openWorld ?? false,
  };
  const register = (server: McpServer, context: ToolContext) => {
    // The SDK's callback type depends on the input schema through a conditional type, which
    // TypeScript can't resolve for a generic schema. Registering with the base schema type and
    // narrowing the argument once keeps the handler's input fully typed.
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        ...(spec.output !== undefined && { outputSchema: spec.output }),
        annotations,
      },
      // The SDK has already validated `input` against `spec.input`, so it has the parsed type.
      // Parsing it again would break schemas with transforms, so the assertion stands in.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (input) => runTool(spec, input as z.infer<Input>, context),
    );
  };
  return { name: spec.name, title: spec.title, register };
}

async function runTool<Input extends z.ZodObject, Output extends z.ZodObject | undefined>(
  spec: ToolSpec<Input, Output>,
  input: z.infer<Input>,
  context: ToolContext,
): Promise<CallToolResult> {
  if (spec.scope !== undefined && !context.props.scopes.includes(spec.scope)) {
    return toolError(
      `The ${spec.name} tool needs the "${spec.scope}" scope, which this connection wasn't granted.`,
      `Reconnect the server and approve the "${spec.scope}" scope, or use a tool that doesn't need it.`,
    );
  }

  try {
    const value = await spec.handler(input, context);
    const text = JSON.stringify(value ?? null, null, 2);
    if (spec.output !== undefined && isRecord(value)) {
      return { content: [{ type: "text", text }], structuredContent: value };
    }
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (error instanceof ToolInputError) {
      return toolError(error.message, error.fix);
    }
    if (error instanceof HttpError) {
      if (error.status >= 500) {
        // The cause can carry upstream detail, such as part of a response body, so only the fields
        // that identify the failure are logged.
        log.warn("mcp.tool_failed_upstream", {
          tool: spec.name,
          login: context.props.login,
          status: error.status,
          service: error instanceof UpstreamError ? error.service : undefined,
          upstreamStatus: error instanceof UpstreamError ? error.upstreamStatus : undefined,
        });
      }
      return toolError(error.message, fixForStatus(error.status));
    }
    // The SDK turns a `ProtocolError` into a tool error that carries its message, except for a
    // URL elicitation request, which it sends to the client as a JSON-RPC error. Rethrowing lets
    // the SDK apply that rule.
    if (error instanceof ProtocolError) {
      throw error;
    }
    // The SDK would turn a thrown error into a tool error that repeats its message, which can carry
    // internal or upstream detail. Log the error here and give the client a generic message.
    log.error("mcp.tool_failed", { tool: spec.name, login: context.props.login, error });
    return toolError(
      `The ${spec.name} tool failed because of an internal error.`,
      "Try again later. If the error continues, tell the server owner.",
    );
  }
}

function toolError(message: string, fix: string): CallToolResult {
  return { content: [{ type: "text", text: `${message}\n\nFix: ${fix}` }], isError: true };
}

function fixForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "Reconnect the server, or ask the server owner for access.";
  }
  if (status === 404) {
    return "Check the identifier, or list the available items and pick one from the result.";
  }
  if (status === 429) {
    return "Wait a minute, then retry the call.";
  }
  if (status >= 500) {
    return "Try again later.";
  }
  return "Change the input as the message describes, then retry the call.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
