// Tests for the text that setup builds: the MCP server's first sentence from the description, the
// D1 database IDs in the Wrangler configs, and the JSON that it reads from tools that print
// notices first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  editInstructions,
  editPreviewMigrations,
  editWrangler,
  instructionsSentence,
  TEMPLATE_INSTRUCTIONS_SENTENCE,
} from "../config.ts";
import { excerpt, parseJson } from "../remote.ts";
import type { Context } from "../types.ts";
import { freshContext } from "./world.ts";

// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

describe("the MCP server's first sentence", () => {
  test("reads as a sentence for a description in the imperative", () => {
    assert.equal(
      instructionsSentence("Check bakery supplies stock levels and see what is running low."),
      "This server helps you check bakery supplies stock levels and see what is running low.",
    );
  });

  test("reads as a sentence for a description in the third person", () => {
    assert.equal(
      instructionsSentence("Tracks support requests for the Acme team."),
      "This server tracks support requests for the Acme team.",
    );
    assert.equal(
      instructionsSentence("Watches the build queue"),
      "This server watches the build queue.",
    );
  });

  test("treats base forms that end in s as the imperative", () => {
    assert.equal(
      instructionsSentence("Access the team's shared notes."),
      "This server helps you access the team's shared notes.",
    );
    assert.equal(
      instructionsSentence("Focus on the open requests."),
      "This server helps you focus on the open requests.",
    );
  });

  test("keeps the template's sentence without a description", () => {
    assert.equal(instructionsSentence(""), TEMPLATE_INSTRUCTIONS_SENTENCE);
    assert.equal(instructionsSentence(undefined), TEMPLATE_INSTRUCTIONS_SENTENCE);
  });

  test("replaces the first sentence once, and again when the description changes", () => {
    const template = `export const INSTRUCTIONS = \`${TEMPLATE_INSTRUCTIONS_SENTENCE} It acts for the user.\`;`;
    const once = editInstructions(template, "Check stock levels.");
    assert.equal(
      once,
      "export const INSTRUCTIONS = `This server helps you check stock levels. It acts for the user.`;",
    );
    assert.equal(editInstructions(once, "Check stock levels."), once);
    assert.equal(
      editInstructions(once, "Tracks orders."),
      "export const INSTRUCTIONS = `This server tracks orders. It acts for the user.`;",
    );
  });
});

const TEMPLATE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function templateFile(file: string): string {
  return readFileSync(path.join(TEMPLATE_ROOT, file), "utf8");
}

function d1Context(database: string): Context {
  const ctx = freshContext();
  Object.assign(ctx.answers, { parts: "mcp,web", "sign-in": "github", database });
  ctx.facts.d1Databases = { production: "d1-production-id", preview: "d1-preview-id" };
  return ctx;
}

describe("the D1 database IDs", () => {
  test("go into the top level and the previews block of wrangler.jsonc, once", () => {
    const ctx = d1Context("d1");
    const once = editWrangler(templateFile("wrangler.jsonc"), ctx);
    const [top = "", previews = ""] = once.split('"previews": {');
    assert.match(top, /^ {6}"database_id": "d1-production-id",$/m);
    assert.match(previews, /^ {8}"database_id": "d1-preview-id",$/m);
    assert.ok(!once.includes("REPLACE_WITH_D1_ID") && !once.includes("REPLACE_WITH_PREVIEW_D1_ID"));
    assert.equal(editWrangler(once, ctx), once);
  });

  test("go into wrangler.preview-migrations.jsonc as the Previews database's ID, once", () => {
    const ctx = d1Context("d1");
    const once = editPreviewMigrations(templateFile("wrangler.preview-migrations.jsonc"), ctx);
    assert.match(once, /^ {6}"database_id": "d1-preview-id",$/m);
    assert.equal(editPreviewMigrations(once, ctx), once);
  });

  test("stay out of the config of a project without D1", () => {
    const text = templateFile("wrangler.jsonc");
    assert.ok(editWrangler(text, d1Context("none")).includes('"REPLACE_WITH_D1_ID"'));
  });
});

describe("JSON from tools that print notices first", () => {
  test("skips notice lines, even ones with brackets", () => {
    const output = [
      "Using redirected Wrangler configuration.",
      "▲ [WARNING] The preview command is in open beta.",
      "{",
      '  "preview": { "urls": ["https://pr-1-acme.example.workers.dev/"] }',
      "}",
    ].join("\n");
    assert.deepEqual(parseJson(output), {
      preview: { urls: ["https://pr-1-acme.example.workers.dev/"] },
    });
  });

  test("reads plain JSON and returns undefined without any", () => {
    assert.deepEqual(parseJson('[{"id":"1"}]'), [{ id: "1" }]);
    assert.equal(parseJson("No JSON here."), undefined);
  });
});

describe("a shortened header", () => {
  test("keeps the part that the check matched", () => {
    const header =
      'Bearer realm="OAuth", error="invalid_token", error_description="The access token is missing or invalid, so sign in again before you call this endpoint", resource_metadata="https://acme-tools.acme.workers.dev/.well-known/cloudflare-access-protected-resource/mcp"';
    const short = excerpt(header, "cloudflare-access-protected-resource");
    assert.ok(short.includes("cloudflare-access-protected-resource"), short);
    assert.ok(short.length <= 206);
    assert.equal(excerpt("Bearer", "Bearer"), "Bearer");
  });
});
