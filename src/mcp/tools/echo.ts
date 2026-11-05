// An example read-only tool. It shows the shape every tool follows: a described input schema, an
// output schema for structured content, and a description written for an agent.
import { z } from "zod";

import { defineTool } from "#mcp/define-tool.ts";

/** Returns the message it receives. Use it to confirm that a client can reach the server. */
export const echoMessage = defineTool({
  name: "example_echo_message",
  title: "Echo a message",
  description:
    "Returns the message you send, unchanged. Call it to check that the connection to this server " +
    "works. It has no side effects. The result contains the message.",
  effect: "read",
  input: z.object({
    message: z.string().min(1).describe("The text to send back. Any non-empty string works."),
  }),
  output: z.object({
    message: z.string().describe("The message from the input, unchanged."),
  }),
  handler: async ({ message }) => ({ message }),
});
