// An example tool that uses the caller's identity and keeps per-user state. It counts how many
// times each user has called it, in KV under a key that holds the user's account ID, so one user's
// data never mixes with another's and survives a rename of their login.
import { z } from "zod";

import { defineTool } from "#mcp/define-tool.ts";

/**
 * Records a visit for the signed-in user and returns who they are. It needs the `profile` scope
 * and declares a `write` effect, because each call changes the stored count. It isn't open world,
 * because the count stays in this server's own KV namespace.
 */
export const recordVisit = defineTool({
  name: "account_record_visit",
  title: "Record a visit",
  description:
    "Records a visit for the signed-in user and returns their identity. Call it when you need to " +
    "know who you're acting for. It takes no input. Each call adds one to the user's visit count. " +
    "The result contains the user's login, display name, granted scopes, visit count, and " +
    "whether the server holds a GitHub token for the user.",
  scope: "profile",
  effect: "write",
  input: z.object({}),
  output: z.object({
    login: z.string().describe("The user's GitHub login."),
    name: z.string().describe("The user's display name."),
    scopes: z.array(z.string()).describe("The scopes granted to this connection."),
    visits: z.number().int().describe("How many times this user has called the tool."),
    hasUpstreamToken: z
      .boolean()
      .describe("Whether the server holds a GitHub access token to call GitHub as the user."),
  }),
  handler: async (_input, { env, props }) => {
    // The `user:` prefix keeps these keys apart from the OAuth provider's grant and token records
    // in the same namespace.
    const key = `user:${props.id}:visits`;
    // KV has no atomic increment, so two concurrent calls can record one visit. That's fine for an
    // example. Use a Durable Object when a count must be exact.
    const stored = Number.parseInt((await env.OAUTH_KV.get(key)) ?? "0", 10);
    const visits = (Number.isNaN(stored) ? 0 : stored) + 1;
    await env.OAUTH_KV.put(key, String(visits));
    // A tool that calls GitHub reads `props.accessToken` the same way. Report only whether it's
    // there, because the token itself must never leave the server.
    return {
      login: props.login,
      name: props.name,
      scopes: props.scopes,
      visits,
      hasUpstreamToken: props.accessToken !== undefined,
    };
  },
});
