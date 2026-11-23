// Tests for who answers each setup question: every spec says whether the person or the agent
// decides, and the rendered block opens with the matching instruction.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
// `describe()` and `test()` from `node:test` return promises that the test runner awaits.
/* oxlint-disable typescript/no-floating-promises */

import { renderQuestion } from "../output.ts";
import { QUESTIONS, question } from "../questions.ts";
import type { QuestionKey } from "../types.ts";
import { freshContext } from "./world.ts";

const AGENT = ["brief", "description", "parts", "database", "license"];
const PERSON = [
  "display-name",
  "sign-in",
  "web-access",
  "who-may-sign-in",
  "cloudflare-account",
  "workers-subdomain",
  "hostname",
  "allowed-github",
  "oauth-previews",
  "access-otp",
  "existing-resources",
];

function render(key: QuestionKey): string {
  return renderQuestion(freshContext(), { kind: "question", key, problem: undefined }).join("\n");
}

function keysDecidedBy(who: string): string[] {
  return QUESTIONS.filter((spec) => spec.decides === who)
    .map((spec) => spec.key)
    .toSorted();
}

describe("who answers a question", () => {
  test("every question names who decides, and the lists match", () => {
    for (const spec of QUESTIONS) {
      assert.ok(spec.decides === "person" || spec.decides === "agent", spec.key);
    }
    assert.deepEqual(keysDecidedBy("agent"), AGENT.toSorted());
    assert.deepEqual(keysDecidedBy("person"), PERSON.toSorted());
  });

  test("a person question tells the agent to ask", () => {
    const text = render("sign-in");
    assert.match(text, /The person answers this one\./);
    assert.doesNotMatch(text, /You answer this one\./);
  });

  test("an agent question tells the agent to decide", () => {
    for (const key of ["database", "brief"] as const) {
      const text = render(key);
      assert.match(text, /You answer this one\./, key);
      assert.doesNotMatch(text, /Ask the person/, key);
    }
  });

  test("the license suggestion is none", () => {
    assert.equal(question("license").suggest(freshContext())?.value, "none");
  });
});
