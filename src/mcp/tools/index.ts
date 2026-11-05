// The list of tools the server exposes. To add a tool, create a module in this directory that
// exports a `defineTool` registration and add it to this list.
import type { ToolRegistration } from "#mcp/define-tool.ts";

import { echoMessage } from "./echo.ts";
import { recordVisit } from "./record-visit.ts";

/**
 * Every tool registration, in the order that `tools/list` returns them. The server instructions
 * list the tools from this array too.
 */
export const tools: ToolRegistration[] = [echoMessage, recordVisit];
