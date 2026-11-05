// The instructions that the server sends to clients when they connect. Clients add them to the
// agent's context, so they're written for an agent and say what the server is for and how its
// tools fit together. The tool list comes from `tools/index.ts`, so it can't drift from the tools
// that the server registers.
import { tools } from "#mcp/tools/index.ts";

const toolList = tools.map((tool) => `- ${tool.name}: ${tool.title}.`).join("\n");

/** Server instructions returned in the `initialize` result. */
export const INSTRUCTIONS = `This server is a starting point for an MCP server on Cloudflare Workers. It acts for one signed-in user.

It has these tools:
${toolList}

Each tool's description says when to call it, what it changes, and what it returns. Read it before the first call.

When a tool returns an error, the text ends with a line that starts with "Fix:". Follow that advice before you retry the call.`;
