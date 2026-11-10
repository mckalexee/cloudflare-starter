# Conventions

This page describes how code and documentation are organized in this repository. Follow it for
every change. `pnpm verify` enforces the parts that a tool can check; the rest depends on you.

## Where documentation goes

Each document has one audience. Put information in the first place that fits.

| File          | Audience                                                                       | Contents                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`   | A coding agent changing the code                                               | Exact commands, invariants that the code can't show, checklists for common changes, and links to `docs/`. Keep it under 120 lines. `CLAUDE.md` is a symlink to it. |
| `README.md`   | A person deciding whether to use the project, or running it for the first time | What the project does, the stack, how to run it locally, how to connect a client, and where to read more.                                                          |
| `docs/`       | Anyone who needs the reasoning behind a part of the system                     | One file per topic, such as conventions, deployment, or testing.                                                                                                   |
| Code comments | The next person who reads that file                                            | What the file owns, and why a piece of code is written the way it is.                                                                                              |

Leave out anything that a reader can discover from the code in a few seconds, such as a file
listing or a description of a function signature. Duplicated facts drift apart over time.

## File layout and naming

- `src/worker.ts` is the composition root and the only module that knows about every area.
- Each directory under `src/` owns one area. `http` holds the Hono routes and middleware, and
  `lib` holds shared helpers with no knowledge of any area.

<!-- @starter:mcp -->

- `mcp` holds the MCP server and its tools, and `auth` holds the authentication for the MCP
  endpoint.

<!-- @starter:end -->

<!-- @starter:web -->

- `web` holds the React Router app.

<!-- @starter:end -->

<!-- @starter:mcp -->

- `src/mcp` and `src/auth` never import `src/web`, `react`, or `react-router`. Oxlint enforces
  this so that a project can delete the web app without breaking the MCP endpoint.

<!-- @starter:end -->

- Tests live in `test/`, in a directory named after the area they cover, as
  `test/<area>/<subject>.test.ts`.
- Use kebab case for file names, such as `define-tool.ts`.
- Use the `#` subpath import for any module outside the current directory, such as
  `import { log } from "#lib/log.ts"`. Use a relative import only for a sibling file, or for a
  test helper in `test/helpers/` (`../helpers/network.ts`), which the `#` import doesn't cover.

<!-- @starter:web -->

- React Router route modules follow the URL, such as `routes/account.tsx`, and import the route
  types that React Router generates through a relative path (`./+types/home.ts`).

<!-- @starter:end -->

- Always write the file extension in an import path. Node subpath imports map the specifier
  straight to a file, so the specifier must carry the extension for `#` imports to resolve.
- Prefer named exports. Use a default export only where a framework requires one, such as a
  route module, a config file, or the Worker entry.

## Comments

Comments explain intent. The code already says what it does.

- Every source file opens with a header comment: one short paragraph, in prose, that says what
  the file owns and why it exists. Don't add an author, a date, or a change history.
- Every exported symbol has a JSDoc comment written as prose. Don't use `@param`, `@returns`, or
  other tags, because the types carry that information.
- Inline comments explain why: a constraint, a workaround, a non-obvious ordering, or a value
  chosen for a reason. If a comment restates the next line of code, delete it.
- Don't reference chat sessions, plans, tickets, or pull requests. A comment must make sense to a
  reader who has only the repository.
- Configuration files that allow comments (`wrangler.jsonc`, `.oxlintrc.json`) follow the same
  rules. Explain why a setting is there, in one line, when the reason isn't obvious.

## Errors

- Define typed error classes in `src/lib/errors.ts` when more than one area handles them, and in
  the area's own `errors.ts` otherwise. Each class carries the information that its caller needs
  to respond, such as an HTTP status or a hint for fixing the input.
- Throw these classes from the code that detects the problem. Don't build responses deep in the
  call stack.
- Map errors to responses at the edges, such as the Hono `onError` handler for HTTP.

<!-- @starter:mcp -->

- The tool wrapper in `src/mcp/define-tool.ts` is the edge for MCP tool results.

<!-- @starter:end -->

- Let unexpected errors propagate. The edge logs them and returns a generic 500 response, so the
  client never sees a stack trace or an upstream error body.

## Logging

- Log through `src/lib/log.ts`. It writes one JSON object per line, which Workers Logs indexes by
  field. It's the only module allowed to call `console`.
- Name each event with a short, stable, dotted string, such as `http.unhandled_error`. Put the
  detail in fields, not in the event name.
- Never log tokens, secrets, cookies, or other credentials. Log a user ID or a login when you
  need to identify who made a request.

<!-- @starter:mcp -->

- Never log `AuthProps`, because they can hold the user's upstream access token.

<!-- @starter:end -->

- Log a full URL only when it can't carry a credential. Log the path otherwise.

## Dependencies

Each dependency is code that you maintain, update, and audit. Before you add one, check that all
of the following are true:

- The Workers runtime, the existing dependencies, or a short helper in `src/lib/` can't do the
  job.
- The package runs in workerd without Node-only APIs beyond what `nodejs_compat` provides.
- The package is maintained and its size is reasonable for a Worker bundle.

Pin the exact version (`pnpm add -E`). Renovate proposes updates.

<!-- @starter:mcp -->

`agents` and `@modelcontextprotocol/server` move together, because `agents` requires an exact
version of the MCP SDK.

<!-- @starter:end -->

## Writing style

Write prose, including comments, commit messages, and pull request descriptions, in the style of
the [Google developer documentation style guide](https://developers.google.com/style).

- Address the reader as "you", in active voice and present tense.
- Use sentence case for headings.
- Lead with the point, then give the detail.
- Use code font for code, commands, file names, and literal values.
- Don't use em dashes. Split the sentence, or restructure it.
