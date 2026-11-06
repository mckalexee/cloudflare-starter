# MCP tools

This page covers how to design an MCP tool for this server, how `defineTool` registers it, how a
tool reaches the caller and the Worker bindings, and how to test it. It ends with a worked
example of a tool that calls GitHub as the signed-in user.

## How a request reaches a tool

1. An MCP client sends a JSON-RPC request to `POST /mcp` with an access token.
2. In OAuth mode, the OAuth provider in `src/auth/provider.ts` validates the token and hands the
   request to `mcpApiHandler` in `src/mcp/handler.ts`. In bearer mode, `src/auth/bearer.ts`
   checks the static token instead.
3. The handler wraps the stateless `createMcpHandler` from `agents/mcp/server`. For every request,
   it builds a fresh server with `createServer()` from `src/mcp/server.ts`, so no state outlives
   the request.
4. `createServer()` registers every tool in the `tools` array of `src/mcp/tools/index.ts`, each
   with the same `ToolContext`: the Worker bindings and the caller's props.

`McpAgent` from `agents/mcp` is deprecated, and oxlint rejects any import of it.

## Design a tool

An agent picks a tool from its name and description alone, often next to tools from other
servers. Write both for an agent that has never seen the system behind the tool.

### Name

Use `<area>_<verb>_<noun>`, in lowercase with underscores, such as `github_list_repositories` or
`account_record_visit`. The area keeps your tools apart from other servers' tools, the verb says
what happens, and the noun says what it happens to. Use the same verb for the same kind of
action across tools: `list`, `get`, `create`, `update`, `delete`, `send`.

### Description

Write four parts, in this order:

1. **When to call it**, including when to use a sibling tool instead.
2. **What the inputs mean**, beyond what each field's `.describe()` text says.
3. **What it changes**, or that it changes nothing.
4. **What it returns**, naming the fields an agent can act on.

Describe each input field with `.describe()`: what it is, its format, and its default. Return
only the fields an agent can use. Never return a token, a secret, or the whole props object.

### Effect and open world

`effect` sets the MCP annotations, which clients use to decide when to ask the user for
confirmation. Choose the most honest value:

| `effect`      | Use it for                                           | Annotations                                     |
| ------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `read`        | A tool that only reads                               | `readOnlyHint: true`, `idempotentHint: true`    |
| `write`       | A tool that adds or changes data without deleting it | `readOnlyHint: false`, `destructiveHint: false` |
| `destructive` | A tool that deletes or overwrites data               | `readOnlyHint: false`, `destructiveHint: true`  |

A tool that changes a counter is `write`, not `read`, as `account_record_visit` shows. An update
that replaces a value is `destructive`.

Set `openWorld: true` when the tool reaches people or systems outside this server, such as
calling a public API or sending a message. It sets `openWorldHint`. A tool that only touches this
Worker's own KV namespace isn't open world.

### Scope

Set `scope` when a tool reads or changes the user's data. The scopes are listed in `SCOPES` in
`src/env.ts`, and each one needs a sentence in `SCOPE_DESCRIPTIONS`, which the consent page shows.
Describe what the scope allows, not what today's tools do with it.

## How `defineTool` works

The comments in `src/mcp/define-tool.ts` describe what the wrapper does on each call: the scope
check, the result format, the error mapping, and the `mcp.tool_called` log line. `ToolInputError`
in `src/mcp/errors.ts` says when to throw it. Two facts aren't in those comments:

- The MCP SDK validates the input against `input` before the wrapper runs. Invalid input never
  reaches your handler, because the SDK returns a tool error that names the field.
- Every tool error ends with a line that starts with `Fix:`, and the server instructions tell the
  agent to follow it before it retries.

## Props and bindings

A handler receives `(input, { env, props })`.

- `env` is the Worker's `Env`: every binding and var from `wrangler.jsonc`, such as `OAUTH_KV`
  and `APP_NAME`. The MCP handler reads it from `cloudflare:workers`, because the stateless
  handler's server factory doesn't receive the bindings, and passes it to each tool.
- `props` is the caller as `AuthProps` in `src/env.ts`:

| Field         | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `id`          | The numeric GitHub account ID, which never changes. Key per-user data by it.   |
| `login`       | The GitHub login. It changes when the user renames their account.              |
| `name`        | The display name. When GitHub has none, the callback stores the login instead. |
| `scopes`      | The scopes granted to this token, which can be fewer than the grant's.         |
| `accessToken` | The user's GitHub access token. Absent in bearer mode.                         |

`resolveAuthProps()` in `src/mcp/handler.ts` checks the props once per request with a Zod schema
and drops every field that the schema doesn't name. To carry a new field to the tools, add it to
`AuthProps`, to that schema, and to the code that creates the props.

Bearer mode has one user, `OWNER` in `src/auth/bearer.ts`, with `id` `0`, the login `owner`, and
every scope.

Keep per-user KV keys under `user:<id>:`, as `account_record_visit` does with
`user:<id>:visits`.

<!-- @starter:oauth -->

With GitHub OAuth, `src/auth/upstream/github.ts` creates the props when it calls
`completeAuthorization()`. The OAuth provider keeps its grants and tokens in the same KV
namespace as the per-user keys.

## Call GitHub as the user

`account_record_visit` reports `hasUpstreamToken`, whether the server holds a GitHub token for
the caller, without returning the token. A tool that calls GitHub reads `props.accessToken` and
sends it in the `Authorization` header through `fetchJson()` from `src/lib/http.ts`, which adds a
timeout, a size limit, schema validation, and `UpstreamError` on failure.

The token carries the GitHub scopes in `GITHUB_SCOPE` in `src/auth/upstream/github.ts`, which is
`read:user`. A token with no repository scope can still read public data, such as public
repositories. When a tool needs more, add the GitHub scope there. Users get the new scope the
next time they sign in.

<!-- @starter:end -->

## Server instructions

`src/mcp/instructions.ts` holds the instructions that the server returns from `initialize`.
Clients add them to the agent's context, so write them for an agent: what the server is for, how
its tools fit together, and any policy that applies across tools. The tool list in the
instructions comes from the `tools` array, so it can't drift from the registered tools. Update the
prose when you add a tool that changes how the others are used, and put the most important
sentence first.

## Test a tool

Tests call the real MCP handler in workerd through `createMcpClient()` from
`test/helpers/mcp.ts`. The helper speaks JSON-RPC over the Streamable HTTP transport to any
fetch-shaped function and has `initialize()`, `listTools()`, `callTool()`, and a raw `post()`.
`resultText()` returns the text of a tool result.

Pick the client that fits the test:

- **Fixed props:** `createMcpApiHandler({ authContext: { props } })` from `src/mcp/handler.ts`
  serves MCP with the props you pass, so you control the scopes and the access token. With no
  token, the scopes come from `props.scopes`.
- **Bearer mode:** `createBearerHandler({ token })` from `src/auth/bearer.ts` serves MCP as
  the owner.

<!-- @starter:oauth -->

- **The whole OAuth flow:** `createOAuthMcpClient(await mintAccessToken())` calls `/mcp` through
  the Worker entry with a token from a real sign-in, with GitHub replaced by MSW.

<!-- @starter:end -->

Call `useNetwork()` from `test/helpers/network.ts` in any test file whose code makes outbound
requests. [testing.md](testing.md) describes the helpers.

## Worked example: list the user's repositories

This tool lists the signed-in user's GitHub repositories. It adds a scope, calls GitHub with the
user's token, and returns structured content.

Bearer mode has no upstream token, so this tool's GitHub call always fails there with "This
connection has no GitHub token." In bearer mode, follow the same steps with a handler that uses
only its input and this Worker's bindings, as `example_echo_message` and `account_record_visit`
do.

### 1. Add the scope

In `src/env.ts`:

```ts
export const SCOPES = ["profile", "repos"] as const;

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  profile: "See your GitHub login and name.",
  repos: "See your GitHub repositories.",
};
```

### 2. Write the tool

Create `src/mcp/tools/repositories.ts`:

```ts
// Lists the signed-in user's GitHub repositories. It's the example of a tool that calls an
// upstream API as the user, with the GitHub token from the OAuth grant.
import { z } from "zod";

import { HttpError } from "#lib/errors.ts";
import { fetchJson } from "#lib/http.ts";
import { defineTool } from "#mcp/define-tool.ts";

// Only the fields the tool returns. Zod drops the rest of GitHub's response.
const repositorySchema = z.object({
  full_name: z.string(),
  description: z.string().nullable(),
  html_url: z.string(),
  private: z.boolean(),
  updated_at: z.string(),
});

/** Lists the user's most recently updated GitHub repositories. */
export const listRepositories = defineTool({
  name: "github_list_repositories",
  title: "List repositories",
  description:
    "Lists the signed-in user's GitHub repositories, most recently updated first. Call it to " +
    "find a repository's full name, such as `octocat/hello-world`. `limit` sets how many to " +
    "return. It changes nothing. The result contains each repository's full name, " +
    "description, URL, visibility, and last update time.",
  scope: "repos",
  effect: "read",
  openWorld: true,
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("How many repositories to return, from 1 to 50. Defaults to 10."),
  }),
  output: z.object({
    repositories: z.array(
      z.object({
        fullName: z.string().describe("The owner and name, such as `octocat/hello-world`."),
        description: z.string().nullable().describe("The description, or null when it has none."),
        url: z.string().describe("The repository's page on GitHub."),
        private: z.boolean().describe("Whether the repository is private."),
        updatedAt: z.string().describe("When the repository last changed, as an ISO 8601 time."),
      }),
    ),
  }),
  handler: async ({ limit }, { props }) => {
    if (props.accessToken === undefined) {
      throw new HttpError(401, "This connection has no GitHub token.");
    }
    const url = new URL("https://api.github.com/user/repos");
    url.search = new URLSearchParams({ sort: "updated", per_page: String(limit) }).toString();
    const repositories = await fetchJson(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${props.accessToken}`,
        "User-Agent": "mcp-server",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      schema: z.array(repositorySchema),
      service: "GitHub",
    });
    return {
      repositories: repositories.map((repository) => ({
        fullName: repository.full_name,
        description: repository.description,
        url: repository.html_url,
        private: repository.private,
        updatedAt: repository.updated_at,
      })),
    };
  },
});
```

GitHub's REST API rejects requests without a `User-Agent`. Use your project's name.

### 3. Register it

In `src/mcp/tools/index.ts`, import the tool and add it to the array:

```ts
import { listRepositories } from "./repositories.ts";

export const tools: ToolRegistration[] = [echoMessage, recordVisit, listRepositories];
```

### 4. Test it

Create `test/mcp/repositories.test.ts`:

```ts
// Tests for github_list_repositories, with fixed props and GitHub's API replaced by MSW.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpApiHandler } from "#mcp/handler.ts";

import { createMcpClient, resultText } from "../helpers/mcp.ts";
import { useNetwork } from "../helpers/network.ts";

const network = useNetwork();

afterEach(() => {
  vi.restoreAllMocks();
});

// The props that the OAuth provider would set for a signed-in user with the `repos` scope.
const ADA = { id: 1, login: "ada", name: "Ada", scopes: ["repos"], accessToken: "gho_test" };

function clientFor(props: Record<string, unknown>) {
  const handler = createMcpApiHandler({ authContext: { props } });
  return createMcpClient((request) => handler(request, env, createExecutionContext()));
}

describe("github_list_repositories", () => {
  it("returns the repositories that GitHub lists for the user's token", async () => {
    network.use(
      http.get("https://api.github.com/user/repos", ({ request }) => {
        const url = new URL(request.url);
        if (
          request.headers.get("Authorization") !== "Bearer gho_test" ||
          url.searchParams.get("per_page") !== "1"
        ) {
          return HttpResponse.json({ message: "Unexpected request" }, { status: 400 });
        }
        return HttpResponse.json([
          {
            full_name: "ada/engine",
            description: null,
            html_url: "https://github.com/ada/engine",
            private: false,
            updated_at: "2026-11-01T00:00:00Z",
          },
        ]);
      }),
    );

    const result = await clientFor(ADA).callTool("github_list_repositories", { limit: 1 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      repositories: [
        {
          fullName: "ada/engine",
          description: null,
          url: "https://github.com/ada/engine",
          private: false,
          updatedAt: "2026-11-01T00:00:00Z",
        },
      ],
    });
  });

  it("returns a tool error that names GitHub when the API fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    network.use(
      http.get("https://api.github.com/user/repos", () => HttpResponse.json({}, { status: 503 })),
    );

    const result = await clientFor(ADA).callTool("github_list_repositories", {});

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("GitHub returned an error.");
  });

  it("returns a tool error when the connection lacks the repos scope", async () => {
    const result = await clientFor({ ...ADA, scopes: ["profile"] }).callTool(
      "github_list_repositories",
      {},
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('needs the "repos" scope');
  });
});
```

### 5. Run the checks

Run `pnpm verify`. `test/mcp/tools.test.ts` compares `tools/list` with the `tools` array, so the
new tool needs no change there.

<!-- @starter:oauth -->

`test/auth/discovery.test.ts` compares `scopes_supported` with `SCOPES` the same way.

<!-- @starter:end -->
