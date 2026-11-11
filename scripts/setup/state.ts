// Reads and writes the two state files. `setup.json` holds the answers and the IDs of the
// resources that setup created, and is committed, so a new clone resumes with them. `setup.local.json`, which Git ignores, holds what mustn't be committed:
// who may sign in, the two last tasks' answers, hashes of uploaded secrets, and caches that the
// script would otherwise recompute. Everything else is read back from the repository and the
// accounts on every run.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AnswerKey, Answers, LocalState, Resources } from "./types.ts";

/** The committed state file, at the repository root. */
export const SHARED_FILE = "setup.json";

/** The ignored state file, at the repository root. */
export const LOCAL_FILE = "setup.local.json";

const ANSWER_ORDER: AnswerKey[] = [
  "brief",
  "display-name",
  "description",
  "parts",
  "sign-in",
  "web-access",
  "who-may-sign-in",
  "cloudflare-account",
  "workers-subdomain",
  "hostname",
  "allowed-github",
  "oauth-previews",
  "license",
  "access-otp",
  "existing-resources",
  "mcp-client",
  "renovate",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) {
    return {};
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${path.basename(file)} must hold a JSON object.`);
  }
  return parsed;
}

function readAnswers(value: unknown): Answers {
  const answers: Answers = {};
  if (!isRecord(value)) {
    return answers;
  }
  for (const key of ANSWER_ORDER) {
    const answer = value[key];
    if (typeof answer === "string") {
      answers[key] = answer;
    }
  }
  return answers;
}

function sortedAnswers(answers: Answers): Answers {
  const sorted: Answers = {};
  for (const key of ANSWER_ORDER) {
    const answer = answers[key];
    if (answer !== undefined) {
      sorted[key] = answer;
    }
  }
  return sorted;
}

// Objects only, two-space indents, and a final newline, which is how `oxfmt` prints JSON, so
// `pnpm verify` accepts the committed file.
function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The answers in `setup.json`. */
export function readShared(root: string): Answers {
  return readAnswers(readJson(path.join(root, SHARED_FILE)).answers);
}

const RESOURCE_KEYS: (keyof Resources)[] = [
  "kvProduction",
  "kvPreview",
  "accessAllow",
  "accessBypass",
  "worker",
];

/** The resource IDs in `setup.json`. */
export function readResources(root: string): Resources {
  const raw = readJson(path.join(root, SHARED_FILE)).resources;
  const resources: Resources = {};
  if (isRecord(raw)) {
    for (const key of RESOURCE_KEYS) {
      const id = raw[key];
      if (typeof id === "string") {
        resources[key] = id;
      }
    }
  }
  return resources;
}

function writeSharedFile(root: string, answers: Answers, resources: Resources): void {
  const sorted: Resources = {};
  for (const key of RESOURCE_KEYS) {
    if (resources[key] !== undefined) {
      sorted[key] = resources[key];
    }
  }
  writeJson(path.join(root, SHARED_FILE), {
    answers: sortedAnswers(answers),
    ...(Object.keys(sorted).length === 0 ? {} : { resources: sorted }),
  });
}

/** Writes the answers to `setup.json`, keeping its resource IDs. */
export function writeShared(root: string, answers: Answers): void {
  writeSharedFile(root, answers, readResources(root));
}

/** Records the IDs of resources that setup created or the person adopted, in `setup.json`. */
export function recordResources(root: string, ids: Resources): void {
  writeSharedFile(root, readShared(root), { ...readResources(root), ...ids });
}

/** The state in `setup.local.json`. */
export function readLocal(root: string): LocalState {
  const raw = readJson(path.join(root, LOCAL_FILE));
  const hashes: LocalState["secretHashes"] = {};
  if (isRecord(raw.secretHashes)) {
    for (const target of ["production", "preview", "apiToken"] as const) {
      const hash = raw.secretHashes[target];
      if (typeof hash === "string") {
        hashes[target] = hash;
      }
    }
  }
  const state: LocalState = { answers: readAnswers(raw.answers), secretHashes: hashes };
  if (typeof raw.installedFor === "string") {
    state.installedFor = raw.installedFor;
  }
  if (typeof raw.verifiedFingerprint === "string") {
    state.verifiedFingerprint = raw.verifiedFingerprint;
  }
  if (raw.summaryShown === true) {
    state.summaryShown = true;
  }
  if (typeof raw.fixtureSkipped === "string") {
    state.fixtureSkipped = raw.fixtureSkipped;
  }
  if (typeof raw.validated === "string") {
    state.validated = raw.validated;
  }
  return state;
}

/** Writes `setup.local.json`, readable only by its owner, because it can hold email addresses. */
export function writeLocal(root: string, state: LocalState): void {
  const file = path.join(root, LOCAL_FILE);
  writeJson(file, { ...state, answers: sortedAnswers(state.answers) });
  chmodSync(file, 0o600);
}

/** Changes `setup.local.json` with `update` and writes it back. */
export function updateLocal(root: string, update: (state: LocalState) => void): void {
  const state = readLocal(root);
  update(state);
  writeLocal(root, state);
}

/** Deletes `setup.local.json`, for `finish` after every check passed. */
export function removeLocal(root: string): void {
  rmSync(path.join(root, LOCAL_FILE), { force: true });
}

/** The answers from both files, merged. */
export function mergedAnswers(root: string, local: LocalState): Answers {
  return { ...readShared(root), ...local.answers };
}

/** Parses `.dev.vars` into its keys and values. Missing file means no keys. */
export function readDevVars(root: string): Map<string, string> {
  const file = path.join(root, ".dev.vars");
  const values = new Map<string, string>();
  if (!existsSync(file)) {
    return values;
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      values.set(match[1], (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return values;
}
