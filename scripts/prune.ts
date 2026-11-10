// Turns the template into one project variant, and later removes the template's prune machinery.
// Run it with `node scripts/prune.ts <mcp-only|app-only|bearer> [--finish]`, or with `--finish`
// alone for a project that keeps both halves.
//
// A variant deletes the marked blocks of the kinds it drops, replaces the blocks that it swaps for
// other content, deletes the files that belong only to those kinds, and removes their
// dependencies from `package.json`. A marker is a comment line that holds only `@starter:mcp`,
// `@starter:web`, or `@starter:oauth`, such as `// @starter:web` in code or `<!-- @starter:web -->`
// in Markdown, and a later `@starter:end` line closes the block. Blocks don't nest. `@starter:oauth` blocks belong to the OAuth flow inside the MCP half, so `bearer`
// drops them, or swaps them for its bearer-token code, and keeps the rest of the MCP half.
//
// `--finish` strips the remaining marker lines and rewrites the `Halves present:` line in
// `AGENTS.md` to name what's left. It deletes `SETUP.md` and the `README.md` line that points to
// it, because setup ends with `--finish`. It also deletes the header sentences that explain the
// markers, the CI job that tests this script, and the script itself. Markers can't remove text
// that `--finish` must delete, so these steps are text edits.
//
// The script plans every change in memory and writes nothing when any check fails, so a stale
// path or a missing anchor leaves the tree as it was. It runs before `pnpm install`, so it uses
// only Node built-ins. It edits text the way `oxfmt` would print it, because `pnpm verify` checks
// the formatting.
import { lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type Kind = "mcp" | "web" | "oauth";
type Variant = "mcp-only" | "app-only" | "bearer";

// A path to delete. With `keep`, the path is a directory and everything in it except the listed
// paths is deleted.
type Removal = { path: string; keep?: string[] };

// Replaces a marked block, markers included, with `content`, instead of deleting or keeping it. A
// swap applies to the one block in `file` whose text contains `anchor`. An empty `content` deletes
// the block, for text that holds only while a kind that the variant keeps sits next to one that it
// drops.
type Swap = { file: string; anchor: string; content: string };

// An edit for `--finish` that markers can't express. `apply` throws an `Error` when the text it
// expects is missing, so a template change that breaks the edit fails loudly.
type TextEdit = { file: string; description: string; apply: (text: string) => string };

type VariantSpec = {
  summary: string;
  dropKinds: Kind[];
  paths: Removal[];
  dependencies: string[];
  // Removed only when no remaining source file imports the package.
  dependenciesIfUnused: string[];
  scripts: Record<string, { from: string; to: string }>;
  swaps: Swap[];
  // Every `mcp` or `oauth` block in these files must match a swap, so OAuth code can't survive in a
  // variant that replaces it.
  swapsCover: string[];
};

const ROOT = path.resolve(import.meta.dirname, "..");
const SELF = "scripts/prune.ts";
const AGENTS = "AGENTS.md";
const SETUP = "SETUP.md";
const README = "README.md";
const HALVES_PREFIX = "Halves present:";
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  ".wrangler",
  ".react-router",
  "coverage",
]);
const SKIP_FILES = new Set([SELF, "pnpm-lock.yaml", "worker-configuration.d.ts"]);
const MARKER = /^\s*(?:\/\/|#|<!--)\s*@starter:([a-z]+)\s*(?:-->)?\s*$/;
const KINDS = new Set<string>(["mcp", "web", "oauth"]);

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const COLLAPSIBLE_FILE = /\.(?:[cm]?[jt]sx?|json|jsonc|json5)$/;

// In bearer mode, `/mcp` goes to the bearer-token handler instead of the OAuth provider. These
// replace the `@starter:oauth` blocks in `src/worker.ts`.
const BEARER_WORKER_HEADER = `// In bearer mode, requests to \`/mcp\` go through the token check in \`src/auth/bearer.ts\`, and
// every other request goes to the Hono app.`;
const BEARER_WORKER_IMPORT = `import { bearerHandler } from "#auth/bearer.ts";`;
const BEARER_WORKER_ROUTE_IMPORT = `import { MCP_ROUTE } from "#mcp/handler.ts";`;
const BEARER_WORKER_HANDLER = `export default {
  fetch: (request, env, ctx) =>
    new URL(request.url).pathname === MCP_ROUTE
      ? bearerHandler.fetch(request, env, ctx)
      : appHandler.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;`;

// Without the MCP endpoint, the Hono app is the whole Worker. This replaces the OAuth provider's
// export in `src/worker.ts`.
const APP_ONLY_WORKER_HANDLER = `export default appHandler;`;

// Bearer mode replaces the OAuth sentences in `AGENTS.md` and `README.md`.
const BEARER_AGENTS_INTRO = `\`src/auth/bearer.ts\` guards it with one static bearer token.`;
const BEARER_README_INTRO = `MCP clients authenticate with one static bearer token.`;
const BEARER_README_FEATURE = `**Bearer mode.** \`/mcp\` accepts one static token from the \`MCP_BEARER_TOKEN\` secret and
serves MCP as a single owner with every scope.`;
const BEARER_README_LOCAL = `For MCP requests, generate a bearer token into \`.dev.vars\` before you start the dev server.
MCP clients send it as \`Authorization: Bearer <token>\`.

\`\`\`sh
echo "MCP_BEARER_TOKEN=$(openssl rand -hex 32)" > .dev.vars
\`\`\``;
const BEARER_README_CLIENT = `Each client sends the token from \`MCP_BEARER_TOKEN\` in an \`Authorization: Bearer <token>\`
header, so use a client that can send a fixed header, such as Claude Code:

\`\`\`sh
claude mcp add --transport http <name> https://<host>/mcp --header "Authorization: Bearer <token>"
\`\`\``;

// The bearer token replaces the OAuth secrets in `wrangler.jsonc` and `.dev.vars.example`.
const BEARER_WRANGLER_SECRETS = `  // From \`.dev.vars\`, Wrangler loads these keys and any key named after a var, and ignores the
  // rest. It generates the secrets' types and refuses to deploy while one is missing.
  "secrets": {
    "required": ["MCP_BEARER_TOKEN"],
  },`;
const BEARER_DEV_VARS = `# Token that MCP clients send as \`Authorization: Bearer <token>\`. Generate one with
# \`openssl rand -hex 32\`.
MCP_BEARER_TOKEN=`;

// Bearer mode has no consent page and no GitHub account. These replace the OAuth wording in the
// files that bearer mode keeps.
const BEARER_SCOPE_DESCRIPTIONS = `  profile: "See your login and name.",`;
const BEARER_ACCESS_TOKEN = `  // Bearer mode never sets \`accessToken\`.`;
const BEARER_MCP_TOKEN_CHECK = `In bearer mode, \`src/auth/bearer.ts\` checks the token against the \`MCP_BEARER_TOKEN\` secret.`;
const BEARER_HOST_CHECK = `\`createMcpApiHandler()\` in \`src/mcp/handler.ts\` checks the \`Host\` header only on \`localhost\` and
\`workers.dev\` by default. To apply the check on the custom domain, pass \`allowedHostnames\` where
\`src/auth/bearer.ts\` creates the production handler. Run \`pnpm test\` afterward, because the tests
send requests to \`localhost\`.`;
const BEARER_ACCESS_BYPASS = `\`\`\`json
{
  "type": "self_hosted",
  "name": "<name> MCP",
  "domain": "<host>/mcp",
  "destinations": [
    { "type": "public", "uri": "<host>/healthz" },
    { "type": "public", "uri": "<host>/mcp" }
  ],
  "policies": [
    {
      "name": "MCP clients",
      "decision": "bypass",
      "include": [{ "everyone": {} }]
    }
  ]
}
\`\`\`

The bypass application leaves those paths open to everyone. That's intended: \`/healthz\` reveals
nothing, and \`/mcp\` checks the bearer token.`;

const VARIANTS: Record<Variant, VariantSpec> = {
  "mcp-only": {
    summary: "Keep the MCP endpoint and drop the web app.",
    dropKinds: ["web"],
    paths: [
      { path: "src/web" },
      { path: "src/http/access.ts" },
      { path: "src/http/routes/api.ts" },
      { path: "react-router.config.ts" },
      { path: "test/web" },
      { path: "test/http/access.test.ts" },
      { path: "test/helpers/access.ts" },
      { path: "docs/web.md" },
    ],
    dependencies: [
      "react",
      "react-dom",
      "react-router",
      "@react-router/dev",
      "@types/react",
      "@types/react-dom",
      "isbot",
      "jose",
    ],
    dependenciesIfUnused: [],
    scripts: {
      dev: { from: "react-router dev", to: "vite dev" },
      build: { from: "react-router build", to: "vite build" },
      typegen: {
        from: "wrangler types --strict-vars=false && react-router typegen",
        to: "wrangler types --strict-vars=false",
      },
    },
    // The rule that keeps MCP code apart from the web app means nothing without the web app. Its
    // lint override only adds the web app's imports to the root rule, so it goes too. The note
    // about the web app's Access vars in `docs/auth.md` goes for the same reason.
    swaps: [
      { file: AGENTS, anchor: "never import `src/web`", content: "" },
      { file: "docs/conventions.md", anchor: "never import `src/web`", content: "" },
      { file: "docs/auth.md", anchor: "belong to the web app's identity gate", content: "" },
      { file: ".oxlintrc.json", anchor: `"files": ["src/mcp/**", "src/auth/**"]`, content: "" },
    ],
    swapsCover: [],
  },
  "app-only": {
    summary: "Keep the web app and drop the MCP endpoint and its OAuth flow.",
    dropKinds: ["mcp", "oauth"],
    paths: [
      { path: "src/mcp" },
      { path: "src/auth" },
      { path: "src/env.ts" },
      { path: "test/mcp" },
      { path: "test/auth" },
      { path: "test/helpers/mcp.ts" },
      { path: "test/helpers/oauth.ts" },
      { path: "docs/mcp.md" },
      { path: "docs/auth.md" },
    ],
    dependencies: ["agents", "@modelcontextprotocol/server", "@cloudflare/workers-oauth-provider"],
    dependenciesIfUnused: ["zod"],
    scripts: {},
    swaps: [
      { file: "src/worker.ts", anchor: "createProviderCache(", content: APP_ONLY_WORKER_HANDLER },
    ],
    swapsCover: [],
  },
  bearer: {
    summary: "Keep both halves and replace MCP OAuth with one static bearer token.",
    dropKinds: ["oauth"],
    paths: [
      { path: "src/auth", keep: ["src/auth/bearer.ts"] },
      { path: "test/auth" },
      { path: "test/helpers/oauth.ts" },
    ],
    dependencies: ["@cloudflare/workers-oauth-provider"],
    dependenciesIfUnused: [],
    scripts: {},
    swaps: [
      { file: "src/worker.ts", anchor: "OAuth provider first", content: BEARER_WORKER_HEADER },
      { file: "src/worker.ts", anchor: `"#auth/provider.ts"`, content: BEARER_WORKER_IMPORT },
      { file: "src/worker.ts", anchor: `"#lib/log.ts"`, content: BEARER_WORKER_ROUTE_IMPORT },
      { file: "src/worker.ts", anchor: "createProviderCache(", content: BEARER_WORKER_HANDLER },
      { file: "wrangler.jsonc", anchor: `"GITHUB_CLIENT_ID"`, content: BEARER_WRANGLER_SECRETS },
      { file: ".dev.vars.example", anchor: "GITHUB_CLIENT_ID=", content: BEARER_DEV_VARS },
      { file: "src/env.ts", anchor: "See your GitHub login", content: BEARER_SCOPE_DESCRIPTIONS },
      { file: "src/env.ts", anchor: "`accessToken` is the user's", content: BEARER_ACCESS_TOKEN },
      {
        file: "docs/mcp.md",
        anchor: "validates the token and calls",
        content: BEARER_MCP_TOKEN_CHECK,
      },
      { file: "docs/deploy.md", anchor: "pass `allowedHostnames`", content: BEARER_HOST_CHECK },
      { file: "docs/web.md", anchor: "<name> MCP and OAuth", content: BEARER_ACCESS_BYPASS },
      {
        file: AGENTS,
        anchor: "The OAuth provider in `src/auth` guards it",
        content: BEARER_AGENTS_INTRO,
      },
      { file: README, anchor: "sign in with GitHub through OAuth", content: BEARER_README_INTRO },
      { file: README, anchor: "**OAuth.**", content: BEARER_README_FEATURE },
      { file: README, anchor: "set up GitHub OAuth before", content: BEARER_README_LOCAL },
      {
        file: README,
        anchor: "consent page and the GitHub sign-in",
        content: BEARER_README_CLIENT,
      },
    ],
    swapsCover: ["src/worker.ts"],
  },
};

const FINISH_EDITS: TextEdit[] = [
  {
    file: "wrangler.jsonc",
    description: "remove the header sentence about markers",
    apply: (text) => removeHeaderSentence(text, "Blocks between"),
  },
  {
    file: "renovate.json5",
    description: "remove the header sentence about markers",
    apply: (text) => removeHeaderSentence(text, "Blocks between"),
  },
  {
    file: ".github/workflows/ci.yml",
    description: "remove the prune job",
    apply: removePruneJob,
  },
];

function isKind(name: string): name is Kind {
  return KINDS.has(name);
}

function isVariant(name: string): name is Variant {
  return Object.hasOwn(VARIANTS, name);
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

// Thrown for any check that fails while the script plans its changes.
class PruneError extends Error {
  override readonly name = "PruneError";
}

// An in-memory view of the tree. Reads see earlier planned writes and deletions, and nothing
// reaches the disk until `commit`.
class Workspace {
  readonly #writes = new Map<string, string>();
  readonly #deletions: string[] = [];

  read(file: string): string {
    if (this.isDeleted(file)) {
      throw new PruneError(`${file} is deleted by this run, so it can't be edited.`);
    }
    return this.#writes.get(file) ?? readFileSync(path.join(ROOT, file), "utf8");
  }

  write(file: string, text: string): void {
    if (text !== this.read(file)) {
      this.#writes.set(file, text);
    }
  }

  delete(file: string): void {
    this.#deletions.push(file);
    for (const written of this.#writes.keys()) {
      if (isWithin(written, file)) {
        this.#writes.delete(written);
      }
    }
  }

  isDeleted(file: string): boolean {
    return this.#deletions.some((deleted) => isWithin(file, deleted));
  }

  changedFiles(): string[] {
    return [...this.#writes.keys()].toSorted();
  }

  /** Every text file in the tree that this run hasn't deleted, as paths relative to the root. */
  textFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (this.isDeleted(rel)) {
          continue;
        }
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            walk(rel);
          }
        } else if (entry.isFile() && !SKIP_FILES.has(rel) && isText(rel)) {
          files.push(rel);
        }
      }
    };
    walk("");
    return files.toSorted();
  }

  commit(): void {
    for (const [file, text] of this.#writes) {
      writeFileSync(path.join(ROOT, file), text);
    }
    for (const file of this.#deletions) {
      rmSync(path.join(ROOT, file), { recursive: true, force: true });
    }
  }
}

function isWithin(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

function isText(file: string): boolean {
  const sample = readFileSync(path.join(ROOT, file)).subarray(0, 8000);
  return !sample.includes(0);
}

function exists(file: string): boolean {
  try {
    lstatSync(path.join(ROOT, file));
    return true;
  } catch {
    return false;
  }
}

// Whether a file is missing because a variant deletes it, such as `docs/web.md` after `mcp-only`.
// A swap for that file has nothing to replace when `bearer` runs later, while a swap for any other
// missing file is stale.
function removedByEarlierVariant(file: string): boolean {
  return (
    !exists(file) &&
    Object.values(VARIANTS).some((spec) =>
      spec.paths.some(
        (removal) => isWithin(file, removal.path) && !(removal.keep ?? []).includes(file),
      ),
    )
  );
}

// Whether a path is on disk and this run hasn't planned to delete it.
function isPresent(ws: Workspace, file: string): boolean {
  return exists(file) && !ws.isDeleted(file);
}

// `removed` counts the deleted blocks by label, such as `@starter:web` or `empty @starter:mcp`.
type BlockResult = { text: string; removed: Map<string, number>; swapped: Swap[] };

// Deletes the blocks of the given kinds, applies the swaps, and drops empty blocks. With `strip`,
// it also deletes every remaining marker line and keeps the content between them.
function processBlocks(
  file: string,
  text: string,
  options: { drop: readonly Kind[]; swaps: readonly Swap[]; cover: boolean; strip: boolean },
): BlockResult {
  const lines = text.split("\n");
  const out: string[] = [];
  const seams: number[] = [];
  const removed = new Map<string, number>();
  const swapped: Swap[] = [];
  let open: { kind: Kind; line: number; body: string[]; marker: string } | undefined;

  const closeBlock = (
    block: { kind: Kind; line: number; body: string[]; marker: string },
    end: string,
  ) => {
    const body = block.body.join("\n");
    const matches = options.swaps.filter((swap) => body.includes(swap.anchor));
    if (matches.length > 1) {
      throw new PruneError(`${file}:${block.line}: more than one swap matches this block.`);
    }
    const [swap] = matches;
    if (swap !== undefined) {
      swapped.push(swap);
      if (swap.content === "") {
        seams.push(out.length);
      } else {
        out.push(...swap.content.split("\n"));
      }
    } else if (options.cover && block.kind !== "web") {
      throw new PruneError(
        `${file}:${block.line}: no swap covers this @starter:${block.kind} block, so its code would survive.`,
      );
    } else if (
      options.drop.includes(block.kind) ||
      block.body.every((line) => line.trim() === "")
    ) {
      const label = `${options.drop.includes(block.kind) ? "" : "empty "}@starter:${block.kind}`;
      removed.set(label, (removed.get(label) ?? 0) + 1);
      seams.push(out.length);
    } else if (options.strip) {
      seams.push(out.length);
      out.push(...block.body);
      seams.push(out.length);
    } else {
      out.push(block.marker, ...block.body, end);
    }
  };

  lines.forEach((line, index) => {
    const match = MARKER.exec(line);
    const name = match?.[1];
    if (name === undefined) {
      if (open === undefined) {
        out.push(line);
      } else {
        open.body.push(line);
      }
      return;
    }
    const where = `${file}:${index + 1}`;
    if (name === "end") {
      if (open === undefined) {
        throw new PruneError(`${where}: @starter:end has no open block.`);
      }
      closeBlock(open, line);
      open = undefined;
      return;
    }
    if (!isKind(name)) {
      throw new PruneError(`${where}: unknown marker @starter:${name}.`);
    }
    if (open !== undefined) {
      throw new PruneError(
        `${where}: @starter:${name} opens inside the block from line ${open.line}. Blocks don't nest.`,
      );
    }
    open = { kind: name, line: index + 1, body: [], marker: line };
  });
  if (open !== undefined) {
    throw new PruneError(`${file}:${open.line}: @starter:${open.kind} is never closed.`);
  }
  return { text: tidySeams(out, seams).join("\n"), removed, swapped };
}

// Removing lines can leave blank lines that the formatter would delete: two in a row, one at the
// start or end of a bracketed body, or one at the start or end of the file. This deletes them at
// each place where lines were removed.
function tidySeams(lines: string[], seams: number[]): string[] {
  const out = [...lines];
  const unique = [...new Set(seams)].toSorted((a, b) => b - a);
  for (const seam of unique) {
    const before = out[seam - 1];
    const after = out[seam];
    if (isBlank(before) && isBlank(after)) {
      out.splice(seam, 1);
    } else if (isBlank(after) && (seam === 0 || /[[{(]$/.test(before ?? ""))) {
      out.splice(seam, 1);
    } else if (isBlank(before) && (/^\s*[\]})]/.test(after ?? "") || seam === out.length - 1)) {
      out.splice(seam - 1, 1);
    }
  }
  return out;
}

// The formatter prints an array of literals on one line when it fits. Removing a block from a
// multi-line array can leave one that fits, so this joins it the same way.
function collapseArrays(text: string, printWidth: number): string {
  const array =
    /^([ \t]*)((?:"[^"\n]*"|[A-Za-z_$][\w$]*)\s*:\s*)?\[\n((?:[ \t]*(?:"[^"\n]*"|-?\d+(?:\.\d+)?|true|false|null),?\n)*)[ \t]*\](,?)$/gm;
  return text.replace(
    array,
    (whole, indent: string, key: string | undefined, items: string, comma: string) => {
      const values = items
        .split("\n")
        .map((item) => item.trim().replace(/,$/, ""))
        .filter((item) => item !== "");
      const line = `${indent}${key ?? ""}[${values.join(", ")}]${comma}`;
      return line.length <= printWidth ? line : whole;
    },
  );
}

// Deletes one sentence from the comment block at the top of a file and rewraps the block.
function removeHeaderSentence(text: string, start: string): string {
  const lines = text.split("\n");
  const count = lines.findIndex((line) => !line.startsWith("//"));
  const header = lines
    .slice(0, count)
    .map((line) => line.replace(/^\/\/ ?/, ""))
    .join(" ");
  const sentence = new RegExp(`\\s*${start}[^.]*\\.`);
  if (!sentence.test(header)) {
    throw new PruneError(`expected a header sentence that starts with "${start}".`);
  }
  const wrapped = wrapComment(header.replace(sentence, "").trim(), "// ", readPrintWidth());
  return [...wrapped, ...lines.slice(count)].join("\n");
}

function wrapComment(prose: string, prefix: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of prose.split(/\s+/)) {
    if (line !== "" && prefix.length + line.length + 1 + word.length > width) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") {
    lines.push(prefix + line);
  }
  return lines;
}

// Names the halves that the tree keeps, in the form that `AGENTS.md` uses. The tree tells which
// variant ran, so `--finish` works the same whether it runs with the variant or later.
function describeHalves(ws: Workspace): string {
  const halves: string[] = [];
  if (isPresent(ws, "src/mcp")) {
    halves.push(
      isPresent(ws, "src/auth/provider.ts")
        ? "MCP endpoint (OAuth)"
        : "MCP endpoint (bearer token)",
    );
  }
  if (isPresent(ws, "src/web")) {
    halves.push("web app");
  }
  if (halves.length === 0) {
    throw new PruneError("neither src/mcp nor src/web exists, so no half is left to describe.");
  }
  return `${HALVES_PREFIX} ${halves.join(", ")}.`;
}

// Replaces the one line that starts with `Halves present:`.
function rewriteHalvesLine(text: string, line: string): string {
  const lines = text.split("\n");
  const matches = lines.filter((candidate) => candidate.startsWith(HALVES_PREFIX)).length;
  if (matches !== 1) {
    throw new PruneError(
      `expected exactly one line that starts with "${HALVES_PREFIX}", found ${matches}.`,
    );
  }
  const index = lines.findIndex((candidate) => candidate.startsWith(HALVES_PREFIX));
  lines[index] = line;
  return lines.join("\n");
}

// Deletes the one line that mentions `SETUP.md`, if there is one. More than one is an error,
// because deleting several lines could cut a paragraph apart.
function removeSetupPointer(text: string): string {
  const lines = text.split("\n");
  const pointers = lines.flatMap((line, index) => (line.includes(SETUP) ? [index] : []));
  if (pointers.length > 1) {
    throw new PruneError(
      `expected at most one line that mentions ${SETUP}, found ${pointers.length}: lines ${pointers.map((index) => index + 1).join(", ")}.`,
    );
  }
  const [index] = pointers;
  if (index === undefined) {
    return text;
  }
  lines.splice(index, 1);
  return tidySeams(lines, [index]).join("\n");
}

// Deletes the `prune` job, which runs this script, and its line in the header comment. The job
// ends where the next job, `workflows`, starts.
function removePruneJob(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf("  prune:");
  const end = lines.indexOf("  workflows:");
  if (start === -1 || end === -1 || end < start) {
    throw new PruneError("expected a `prune:` job followed by a `workflows:` job.");
  }
  lines.splice(start, end - start);
  const bullet = lines.findIndex((line) => line.startsWith("# - `prune`"));
  if (bullet !== -1) {
    let next = bullet + 1;
    while (lines[next]?.startsWith("#   ")) {
      next++;
    }
    lines.splice(bullet, next - bullet);
  }
  return lines.join("\n");
}

function readPrintWidth(): number {
  try {
    const config: unknown = JSON.parse(readFileSync(path.join(ROOT, ".oxfmtrc.json"), "utf8"));
    if (
      typeof config === "object" &&
      config !== null &&
      "printWidth" in config &&
      typeof config.printWidth === "number"
    ) {
      return config.printWidth;
    }
  } catch {
    // Without a config file the formatter uses its default width.
  }
  return 80;
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function isPackageJson(value: unknown): value is PackageJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeDependency(pkg: PackageJson, name: string): boolean {
  let found = false;
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    if (deps !== undefined && name in deps) {
      delete deps[name];
      found = true;
    }
  }
  return found;
}

function isImported(ws: Workspace, name: string): boolean {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const specifier = new RegExp(
    `(?:from\\s+|import\\s*\\(\\s*|import\\s+)["']${escaped}(?:/[^"']*)?["']`,
  );
  return ws.textFiles().some((file) => CODE_FILE.test(file) && specifier.test(ws.read(file)));
}

// Deletes everything inside `removal.path` except the paths in `removal.keep`.
function deleteExcept(
  ws: Workspace,
  dir: string,
  keep: readonly string[],
  deleted: string[],
): void {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (keep.includes(rel)) {
      continue;
    }
    if (entry.isDirectory() && keep.some((kept) => isWithin(kept, rel))) {
      deleteExcept(ws, rel, keep, deleted);
    } else {
      ws.delete(rel);
      deleted.push(rel);
    }
  }
}

// Collects the report lines for one run.
type Report = { title: string; lines: string[] }[];

function section(report: Report, title: string): string[] {
  const lines: string[] = [];
  report.push({ title, lines });
  return lines;
}

function planVariant(ws: Workspace, variant: Variant, report: Report): void {
  const spec = VARIANTS[variant];
  const errors: string[] = [];

  const missing = spec.paths
    .flatMap((removal) => [removal.path, ...(removal.keep ?? [])])
    .filter((file) => !exists(file));
  if (missing.length > 0) {
    throw new PruneError(
      `The ${variant} file list names paths that don't exist:\n${missing.map((file) => `  ${file}`).join("\n")}`,
    );
  }

  const deleted = section(report, "Deleted files and directories");
  for (const removal of spec.paths) {
    if (removal.keep === undefined) {
      ws.delete(removal.path);
      deleted.push(removal.path);
    } else {
      deleteExcept(ws, removal.path, removal.keep, deleted);
    }
  }

  const blocks = section(report, "Removed blocks");
  const swapped = section(report, "Swapped blocks");
  const usedSwaps = new Set<Swap>();
  for (const file of ws.textFiles()) {
    const swaps = spec.swaps.filter((swap) => swap.file === file);
    try {
      const result = processBlocks(file, ws.read(file), {
        drop: spec.dropKinds,
        swaps,
        cover: spec.swapsCover.includes(file),
        strip: false,
      });
      ws.write(file, result.text);
      for (const [label, count] of result.removed) {
        blocks.push(`${file}: ${count} ${label}`);
      }
      for (const swap of result.swapped) {
        usedSwaps.add(swap);
        swapped.push(`${file}: the block with ${swap.anchor}`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const swap of spec.swaps) {
    if (!usedSwaps.has(swap) && !removedByEarlierVariant(swap.file)) {
      errors.push(`${swap.file}: no marked block contains ${swap.anchor}.`);
    }
  }

  const pkg: unknown = JSON.parse(ws.read("package.json"));
  if (!isPackageJson(pkg)) {
    throw new PruneError("package.json doesn't hold a JSON object.");
  }
  const deps = section(report, "Removed dependencies");
  for (const name of spec.dependencies) {
    if (removeDependency(pkg, name)) {
      deps.push(name);
    } else {
      errors.push(`package.json: the dependency ${name} isn't listed.`);
    }
  }
  for (const name of spec.dependenciesIfUnused) {
    if (isImported(ws, name)) {
      deps.push(`${name} kept, because a remaining file imports it`);
    } else if (removeDependency(pkg, name)) {
      deps.push(name);
    }
  }
  const scripts = section(report, "Rewritten package.json scripts");
  for (const [name, { from, to }] of Object.entries(spec.scripts)) {
    if (pkg.scripts?.[name] !== from) {
      errors.push(`package.json: expected the ${name} script to be "${from}".`);
      continue;
    }
    pkg.scripts[name] = to;
    scripts.push(`${name}: ${to}`);
  }
  ws.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

  if (errors.length > 0) {
    throw new PruneError(
      `The ${variant} variant can't be applied:\n${errors.map((error) => `  ${error}`).join("\n")}`,
    );
  }
}

function planFinish(ws: Workspace, report: Report): void {
  const errors: string[] = [];
  const stripped = section(report, "Stripped markers");
  for (const file of ws.textFiles()) {
    try {
      const result = processBlocks(file, ws.read(file), {
        drop: [],
        swaps: [],
        cover: false,
        strip: true,
      });
      if (result.text !== ws.read(file)) {
        ws.write(file, result.text);
        stripped.push(file);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const edited = section(report, "Text edits");
  const notices = section(report, "Notices");
  const edits = [...FINISH_EDITS];
  if (isPresent(ws, AGENTS)) {
    edits.push({
      file: AGENTS,
      description: "list the halves that remain on the Halves present line",
      apply: (text) => rewriteHalvesLine(text, describeHalves(ws)),
    });
  } else {
    notices.push(`${AGENTS} doesn't exist, so no Halves present line was rewritten.`);
  }
  if (isPresent(ws, README)) {
    edits.push({
      file: README,
      description: `remove the line that points to ${SETUP}`,
      apply: removeSetupPointer,
    });
  }
  for (const edit of edits) {
    try {
      const text = ws.read(edit.file);
      const next = edit.apply(text);
      if (next !== text) {
        ws.write(edit.file, next);
        edited.push(`${edit.file}: ${edit.description}`);
      }
    } catch (error) {
      errors.push(
        `${edit.file}: ${edit.description}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const deleted = section(report, "Deleted files and directories");
  if (isPresent(ws, SETUP)) {
    ws.delete(SETUP);
    deleted.push(SETUP);
    for (const file of ws.textFiles()) {
      if (ws.read(file).includes(SETUP)) {
        notices.push(`${file} still mentions ${SETUP}, which this run deleted.`);
      }
    }
  }
  ws.delete(SELF);
  deleted.push(SELF);

  const leftovers = ws.textFiles().filter((file) => ws.read(file).includes("@starter:"));
  for (const file of leftovers) {
    errors.push(`${file} still mentions @starter:. Remove the mention and run --finish again.`);
  }
  if (errors.length > 0) {
    throw new PruneError(
      `--finish can't be applied:\n${errors.map((error) => `  ${error}`).join("\n")}`,
    );
  }
}

// Formats every changed file the way the formatter would after lines were removed.
function collapseChanged(ws: Workspace): void {
  const width = readPrintWidth();
  for (const file of ws.changedFiles()) {
    if (COLLAPSIBLE_FILE.test(file)) {
      ws.write(file, collapseArrays(ws.read(file), width));
    }
  }
}

// Deletes directories that the run left empty, deepest first.
function removeEmptyDirectories(dir = ""): string[] {
  const removed: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      removed.push(...removeEmptyDirectories(rel));
      if (readdirSync(path.join(ROOT, rel)).length === 0) {
        rmdirSync(path.join(ROOT, rel));
        removed.push(rel);
      }
    }
  }
  return removed;
}

function usage(): never {
  console.error(
    [
      "Usage: node scripts/prune.ts <variant> [--finish]",
      "       node scripts/prune.ts --finish",
      "",
      "Variants:",
      ...Object.entries(VARIANTS).map(([name, spec]) => `  ${name.padEnd(9)} ${spec.summary}`),
      "",
      "--finish strips the remaining markers, rewrites the Halves present line in AGENTS.md, and",
      "deletes SETUP.md, its pointer in README.md, the prune job, and this script.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(args: string[]): { variant: Variant | undefined; finish: boolean } {
  let variant: Variant | undefined;
  let finish = false;
  for (const arg of args) {
    if (arg === "--finish") {
      finish = true;
    } else if (variant === undefined && isVariant(arg)) {
      variant = arg;
    } else {
      usage();
    }
  }
  if (variant === undefined && !finish) {
    usage();
  }
  return { variant, finish };
}

function main(): void {
  const { variant, finish } = parseArgs(process.argv.slice(2));
  const ws = new Workspace();
  const report: Report = [];
  try {
    if (variant !== undefined) {
      planVariant(ws, variant, report);
    }
    if (finish) {
      planFinish(ws, report);
    }
    collapseChanged(ws);
  } catch (error) {
    if (error instanceof PruneError) {
      console.error(`${error.message}\n\nNothing was changed.`);
      process.exit(1);
    }
    throw error;
  }

  const written = section(report, "Edited files");
  written.push(...ws.changedFiles());
  ws.commit();
  section(report, "Removed empty directories").push(...removeEmptyDirectories());

  const steps = [variant, finish ? "--finish" : undefined].filter((step) => step !== undefined);
  console.log(`Pruned with ${steps.join(" ")}.`);
  for (const { title, lines } of report) {
    if (lines.length > 0) {
      console.log(`\n${title}:\n${lines.map((line) => `  ${line}`).join("\n")}`);
    }
  }
  console.log(
    finish
      ? "\nNext, run `pnpm install` and `pnpm verify`."
      : "\nNext, run `pnpm install` to update the lockfile, then `pnpm verify`.",
  );
}

main();
