// Tests for the text that setup builds: the MCP server's first sentence from the description, and
// the JSON that it reads from tools that print notices first.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  editInstructions,
  instructionsSentence,
  TEMPLATE_INSTRUCTIONS_SENTENCE,
} from "../config.ts";
import { excerpt, parseJson } from "../remote.ts";

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
