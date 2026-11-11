// The text edits that turn the template's configuration into the project's: the vars, the
// hostname, and the IDs in `wrangler.jsonc`, the MCP server's first sentence, and the license. Each
// edit is a pure function of the file's text, so the same code applies an edit and tells whether
// it's still pending. The edits keep the layout that `oxfmt` prints, because `pnpm verify` checks
// the formatting.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { accessUsed, customDomain, hasMcp, hasWeb, host, signIn } from "./derive.ts";
import type { Context } from "./types.ts";

/** The first line of the block that `AGENTS.md` carries until setup finishes. */
export const AGENTS_BLOCK_START = "<!-- setup:begin -->";

/** The last line of that block. */
export const AGENTS_BLOCK_END = "<!-- setup:end -->";

const AGENTS_BLOCK = [
  AGENTS_BLOCK_START,
  "",
  "> [!IMPORTANT]",
  "> Setup isn't finished. Run `node scripts/setup.ts` before any other work, and follow what it",
  "> prints.",
  "",
  AGENTS_BLOCK_END,
];

/** Adds the setup block after the first heading of `AGENTS.md`, unless it's there already. */
export function addAgentsBlock(text: string): string {
  if (text.includes(AGENTS_BLOCK_START)) {
    return text;
  }
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => line.startsWith("# "));
  const at = heading === -1 ? 0 : heading + 1;
  lines.splice(
    at,
    0,
    ...(heading === -1 ? [] : [""]),
    ...AGENTS_BLOCK,
    ...(heading === -1 ? [""] : []),
  );
  return lines.join("\n");
}

const PRINT_WIDTH = 100;

/** The template's first sentence of the MCP server instructions. */
export const TEMPLATE_INSTRUCTIONS_SENTENCE =
  "This server is a starting point for an MCP server on Cloudflare Workers.";

const TEMPLATE_LICENSE_LINE =
  "This project is licensed under [MIT No Attribution (MIT-0)](LICENSE).";

type Block = { start: number; end: number; indent: number };

// Finds the object that opens on the first line matching `opener` at `indent` spaces, after
// `from`, and returns its line range. The closing brace sits at the same indent.
function findBlock(lines: string[], opener: string, indent: number, from = 0): Block | undefined {
  const prefix = `${" ".repeat(indent)}${opener}`;
  const start = lines.findIndex((line, index) => index >= from && line === prefix);
  if (start === -1) {
    return undefined;
  }
  const closer = new RegExp(`^ {${indent}}\\},?$`);
  const end = lines.findIndex((line, index) => index > start && closer.test(line));
  return end === -1 ? undefined : { start, end, indent };
}

// Sets `"key": "<value>"` inside a block, if the block has that key. A pruned project lacks some
// keys, and that's not an error.
function setString(lines: string[], block: Block | undefined, key: string, value: string): void {
  if (block === undefined) {
    return;
  }
  const pattern = new RegExp(`^( {${block.indent + 2}}"${key}": )"(?:[^"\\\\]|\\\\.)*"(,?)$`);
  for (let index = block.start + 1; index < block.end; index++) {
    const match = pattern.exec(lines[index] ?? "");
    if (match !== null) {
      lines[index] = `${match[1] ?? ""}${JSON.stringify(value)}${match[2] ?? ""}`;
      return;
    }
  }
}

// Sets the `id` of the `OAUTH_KV` namespace on the one-line `kv_namespaces` entry at `indent`.
function setKvId(lines: string[], indent: number, from: number, to: number, id: string): void {
  const pattern = new RegExp(
    `^( {${indent}}"kv_namespaces": \\[\\{ "binding": "OAUTH_KV", "id": )"[^"]*"( \\}\\],)$`,
  );
  for (let index = from; index < to; index++) {
    const match = pattern.exec(lines[index] ?? "");
    if (match !== null) {
      lines[index] = `${match[1] ?? ""}${JSON.stringify(id)}${match[2] ?? ""}`;
      return;
    }
  }
}

// The route lines as `oxfmt` prints them: on one line when they fit, otherwise broken open.
function routeLines(hostname: string): string[] {
  const inner = `{ "pattern": ${JSON.stringify(hostname)}, "custom_domain": true }`;
  const flat = `  "routes": [${inner}],`;
  if (flat.length <= PRINT_WIDTH) {
    return [flat];
  }
  const broken = `    ${inner},`;
  if (broken.length <= PRINT_WIDTH) {
    return ['  "routes": [', broken, "  ],"];
  }
  return [
    '  "routes": [',
    "    {",
    `      "pattern": ${JSON.stringify(hostname)},`,
    '      "custom_domain": true,',
    "    },",
    "  ],",
  ];
}

const DOMAIN_COMMENT_START =
  "  // To serve production on a custom domain only, change `workers_dev` to false and uncomment";
const DOMAIN_COMMENT = [
  "  // Production serves on the custom domain only. `preview_urls` keeps Previews on workers.dev.",
];

// Switches `wrangler.jsonc` to a custom domain: `workers_dev` off, `preview_urls` on, and the
// route. A later run replaces the route, so the edit stays idempotent.
function setCustomDomain(lines: string[], hostname: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line === DOMAIN_COMMENT_START) {
      out.push(...DOMAIN_COMMENT);
      index++;
      continue;
    }
    if (line === '  "workers_dev": true,') {
      out.push('  "workers_dev": false,');
      continue;
    }
    if (line === '  // "preview_urls": true,') {
      out.push('  "preview_urls": true,');
      continue;
    }
    if (line.startsWith('  // "routes": [') || line.startsWith('  "routes": [')) {
      // Skip the rest of a route that `oxfmt` broke over several lines.
      if (line === '  "routes": [') {
        while (index < lines.length && lines[index] !== "  ],") {
          index++;
        }
      }
      out.push(...routeLines(hostname));
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Applies every `wrangler.jsonc` edit that the answers and facts call for. */
export function editWrangler(text: string, ctx: Context): string {
  let lines = text.split("\n");
  const { answers, facts } = ctx;
  const vars = findBlock(lines, '"vars": {', 2);
  const previews = findBlock(lines, '"previews": {', 2);
  const previewVars =
    previews === undefined ? undefined : findBlock(lines, '"vars": {', 4, previews.start);
  const both = [vars, previewVars];
  const hostname = host(ctx);

  const displayName = answers["display-name"];
  if (displayName !== undefined) {
    for (const block of both) {
      setString(lines, block, "APP_NAME", displayName);
    }
  }
  if (signIn(answers) === "github") {
    if (hostname !== undefined) {
      setString(lines, vars, "MCP_RESOURCE", `https://${hostname}/mcp`);
    }
    const allowed = answers["allowed-github"];
    if (allowed !== undefined) {
      for (const block of both) {
        setString(lines, block, "ALLOWED_GITHUB_LOGINS", allowed);
      }
    }
  }
  if (hasWeb(answers)) {
    const access = answers["web-access"];
    if (access !== undefined) {
      for (const block of both) {
        setString(lines, block, "WEB_ACCESS", access);
      }
    }
  }
  if (accessUsed(answers)) {
    const teamDomain = facts.accessOrganization?.teamDomain;
    const aud = facts.accessApps.allow?.aud;
    for (const block of both) {
      if (teamDomain !== undefined) {
        setString(lines, block, "ACCESS_TEAM_DOMAIN", teamDomain);
      }
      if (aud !== undefined) {
        setString(lines, block, "ACCESS_AUD", aud);
      }
    }
    const accessBlock = findBlock(lines, '"access": {', 2);
    const dev =
      accessBlock === undefined ? undefined : findBlock(lines, '"dev": {', 4, accessBlock.start);
    if (aud !== undefined) {
      setString(lines, dev, "aud", aud);
    }
  }
  if (hasMcp(answers)) {
    const { production, preview } = facts.kvNamespaces;
    const previewStart = previews?.start ?? lines.length;
    if (production !== null) {
      setKvId(lines, 2, 0, previewStart, production);
    }
    if (preview !== null && previews !== undefined) {
      setKvId(lines, 4, previews.start, previews.end, preview);
    }
  }
  if (customDomain(answers) && hostname !== undefined) {
    lines = setCustomDomain(lines, hostname);
  }
  return lines.join("\n");
}

/** The hostname that `wrangler.jsonc` already uses, in a route or in `MCP_RESOURCE`. */
export function configuredHost(text: string): string | null {
  const route = /^ {2}"routes": \[\{ "pattern": "([^"]+)"/m.exec(text);
  if (route?.[1] !== undefined) {
    return route[1];
  }
  const broken = /^ {2}"routes": \[\n(?: {4}\{ | {4}\{\n {6})"pattern": "([^"]+)"/m.exec(text);
  if (broken?.[1] !== undefined) {
    return broken[1];
  }
  const vars = text.split('"previews": {')[0] ?? "";
  const resource = /"MCP_RESOURCE": "https:\/\/([^/"]+)\/mcp"/.exec(vars);
  return resource?.[1] ?? null;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The first sentence of the MCP server instructions for a description. */
export function instructionsSentence(description: string | undefined): string {
  if (description === undefined || description === "") {
    return TEMPLATE_INSTRUCTIONS_SENTENCE;
  }
  const body = lowerFirst(description.replace(/[.!?]$/, ""));
  // The description starts with a verb. "Tracks requests" follows "This server" as it is, and
  // "Check stock levels", in the imperative, reads right after "This server helps you".
  const verb = body.split(/\s/, 1)[0] ?? "";
  return thirdPerson(verb) ? `This server ${body}.` : `This server helps you ${body}.`;
}

// Whether a verb is in the third person singular, such as "tracks" or "watches". A base form can
// end in "s" too, such as "access", "focus", or "analysis", so those endings don't count.
function thirdPerson(verb: string): boolean {
  return verb.endsWith("s") && !/(ss|us|is)$/.test(verb);
}

/** Replaces the first sentence of `INSTRUCTIONS` in `src/mcp/instructions.ts`. */
export function editInstructions(text: string, description: string | undefined): string {
  return text.replace(
    /(export const INSTRUCTIONS = `)([^`\n]*?[.!?])(?= |\n|`)/,
    (_whole, start: string) => `${start}${instructionsSentence(description)}`,
  );
}

function mitText(year: string, holder: string): string {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function reservedText(year: string, holder: string): string {
  return `Copyright (c) ${year} ${holder}. All rights reserved.\n`;
}

/**
 * Replaces `LICENSE` for the license answer. A file that already starts with the chosen
 * license's first line stays as it is, so the copyright year doesn't change on a later run.
 */
export function editLicense(text: string, license: string | undefined, holder: string): string {
  const year = String(new Date().getFullYear());
  if (license === "mit") {
    return text.startsWith("MIT License\n") ? text : mitText(year, holder);
  }
  if (license === "none") {
    return text.includes("All rights reserved.") ? text : reservedText(year, holder);
  }
  return text;
}

/** Replaces the license sentence in `README.md` for the license answer. */
export function editReadmeLicense(text: string, license: string | undefined): string {
  const sentence =
    license === "mit"
      ? "This project is licensed under the [MIT License](LICENSE)."
      : license === "none"
        ? "This project has no open source license. [LICENSE](LICENSE) reserves all rights."
        : undefined;
  return sentence === undefined ? text : text.replace(TEMPLATE_LICENSE_LINE, sentence);
}

/** One file that the config step edits. */
export type ConfigEdit = { file: string; apply: (text: string) => string };

/** The edits that the config step makes, for the files that exist in the tree. */
export function configEdits(ctx: Context): ConfigEdit[] {
  const edits: ConfigEdit[] = [
    { file: "wrangler.jsonc", apply: (text) => editWrangler(text, ctx) },
    {
      file: "LICENSE",
      apply: (text) => editLicense(text, ctx.answers.license, ctx.repo.origin.owner),
    },
    { file: "README.md", apply: (text) => editReadmeLicense(text, ctx.answers.license) },
  ];
  if (hasMcp(ctx.answers)) {
    edits.push({
      file: "src/mcp/instructions.ts",
      apply: (text) => editInstructions(text, ctx.answers.description),
    });
  }
  return edits.filter((edit) => existsSync(path.join(ctx.repo.root, edit.file)));
}

/** The files that the config step would still change. */
export function pendingConfig(ctx: Context): string[] {
  return configEdits(ctx).flatMap((edit) => {
    const text = readFileSync(path.join(ctx.repo.root, edit.file), "utf8");
    return edit.apply(text) === text ? [] : [edit.file];
  });
}
