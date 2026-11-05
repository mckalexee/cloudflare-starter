// Builds the MCP server for one request. The stateless handler calls this factory for every
// request, so nothing on the server outlives the request that created it.
import { McpServer } from "@modelcontextprotocol/server";

import type { ToolContext } from "#mcp/define-tool.ts";
import { INSTRUCTIONS } from "#mcp/instructions.ts";
import { tools } from "#mcp/tools/index.ts";

// Clients show this name and version. Change the name when you create a project from the template.
const SERVER_INFO = { name: "cloudflare-starter", version: "0.1.0" };

/**
 * Creates a server with every tool in `tools/index.ts` registered for the given bindings and
 * caller. Tests call it directly with their own bindings and props.
 */
export function createServer(context: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const tool of tools) {
    tool.register(server, context);
  }
  return server;
}
