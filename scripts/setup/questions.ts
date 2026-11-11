// The questions that setup asks the person, one at a time. Each question says when it applies,
// how to validate an answer, what to suggest from the facts, and when an answer can no longer
// change because a step already used it. `checkAnswer()` is the rule book for
// `node scripts/setup.ts answer`.
import {
  accessUsed,
  accountId,
  accountLabel,
  customDomain,
  hasMcp,
  hasWeb,
  list,
  needsCustomDomain,
  signIn,
  titleCase,
  workersSubdomain,
  zoneFor,
} from "./derive.ts";
import type { AnswerKey, Answers, Context, QuestionKey, TreeFacts } from "./types.ts";

/** One choice that the person can pick. */
export type Option = { value: string; label: string };

/** A suggested answer and why the script suggests it. */
export type Suggestion = { value: string; reason: string };

/** Everything the script knows about one question. */
export type QuestionSpec = {
  key: QuestionKey;
  /** `local` answers go to `setup.local.json`, because they mustn't be committed. */
  store: "shared" | "local";
  prompt: string;
  /** Extra lines that help the person answer. */
  help: (ctx: Context) => string[];
  /** The choices, or `undefined` for a free-text answer. */
  options: (ctx: Context) => Option[] | undefined;
  /** How a free-text answer looks. */
  format: string;
  /** Turns the typed value into the stored value, or returns an error message. */
  parse: (value: string) => { value: string } | { error: string };
  /** Whether the question applies, from the answers alone. */
  applies: (answers: Answers) => boolean;
  /** When the question applies, in words, for a refused answer. */
  appliesWhen: string;
  /** Whether the facts call for asking. A question that applies but isn't needed has a default. */
  needed: (ctx: Context) => boolean;
  suggest: (ctx: Context) => Suggestion | undefined;
  /** Why the recorded answer doesn't fit the facts, if it doesn't. The planner asks again. */
  invalid: (ctx: Context) => string | undefined;
  /** Why the answer can't change anymore, if a step already used it. */
  locked: (ctx: Context) => string | undefined;
};

const always = () => true;
const never = () => undefined;
const noHelp = () => [];

function choice(values: string[]) {
  return (value: string): { value: string } | { error: string } =>
    values.includes(value) ? { value } : { error: `Use one of: ${values.join(", ")}.` };
}

const NAME_LIKE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@,]+@[a-z0-9.-]+\.[a-z]{2,63}$/;
const GITHUB_LOGIN = /^(?:[a-z\d](?:[a-z\d-]{0,38})|\d+)$/i;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** Whether the working tree holds exactly what the answers select, so the prune step is done. */
export function treeMatches(tree: TreeFacts, answers: Answers): boolean {
  const wanted = (answers.parts ?? "").split(",").toSorted().join(",");
  if (tree.parts.toSorted().join(",") !== wanted) {
    return false;
  }
  return !hasMcp(answers) || tree.signIn === signIn(answers);
}

function pruneRan(ctx: Context): string | undefined {
  if (!ctx.repo.tree.pristine) {
    return "the prune step already removed the code for the earlier choice";
  }
  if (ctx.repo.agentsBlock && treeMatches(ctx.repo.tree, ctx.answers)) {
    return "the prune step already ran for the earlier choice";
  }
  return undefined;
}

function hostUsed(ctx: Context): string | undefined {
  if (ctx.repo.configuredHost !== null) {
    return `wrangler.jsonc already uses ${ctx.repo.configuredHost}`;
  }
  if (ctx.facts.accessApps.allow !== null || ctx.facts.accessApps.bypass !== null) {
    return "the Access applications already cover the earlier hostname";
  }
  if (ctx.facts.githubVariables.HEALTHCHECK_URL !== undefined) {
    return "the HEALTHCHECK_URL repository variable already names the earlier hostname";
  }
  return undefined;
}

function accountUsed(ctx: Context): string | undefined {
  const { facts } = ctx;
  if (
    facts.kvNamespaces.production !== null ||
    facts.kvNamespaces.preview !== null ||
    facts.accessApps.allow !== null ||
    facts.workerSecrets !== null ||
    facts.githubSecrets.includes("CLOUDFLARE_ACCOUNT_ID")
  ) {
    return "the script already created resources in the earlier account";
  }
  return undefined;
}

/** Every question. The planner decides the order in which it asks them. */
export const QUESTIONS: QuestionSpec[] = [
  {
    key: "display-name",
    store: "shared",
    prompt: "What name should people see for the project?",
    help: () => ["It becomes APP_NAME and replaces the template's display name in the docs."],
    options: () => undefined,
    format: "Plain text, up to 60 characters, such as Acme Tools.",
    parse: (value) => {
      const trimmed = value.trim();
      if (trimmed === "" || trimmed.length > 60 || /[`$\\"\n\r\t]/.test(trimmed)) {
        return { error: "Use 1 to 60 characters, without quotes, backticks, $, or backslashes." };
      }
      return { value: trimmed };
    },
    applies: always,
    appliesWhen: "always",
    needed: always,
    suggest: (ctx) => ({
      value: titleCase(ctx.repo.origin.name),
      reason: "It's the project name in title case.",
    }),
    invalid: never,
    locked: never,
  },
  {
    key: "description",
    store: "shared",
    prompt: "In one sentence, what does the project do?",
    help: (ctx) => [
      "Start with a verb, such as: Tracks support requests for the Acme team.",
      "It becomes the repository description" +
        (hasMcp(ctx.answers) ? " and the first sentence of the MCP server's instructions." : "."),
      "Answer none to leave it out.",
    ],
    options: () => undefined,
    format: "One sentence that starts with a verb, or none.",
    parse: (value) => {
      const trimmed = value.trim();
      if (trimmed === "" || trimmed.toLowerCase() === "none") {
        return { value: "" };
      }
      if (trimmed.length > 200 || /[`$\\\n\r\t]/.test(trimmed)) {
        return {
          error: "Use one line of up to 200 characters, without backticks, $, or backslashes.",
        };
      }
      if (/[.!?]\s/.test(trimmed)) {
        return { error: "Use one sentence." };
      }
      return { value: /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.` };
    },
    applies: always,
    appliesWhen: "always",
    needed: always,
    suggest: (ctx) => {
      const current = ctx.facts.repository?.description ?? "";
      return current === ""
        ? undefined
        : { value: current, reason: "It's the repository's current description." };
    },
    invalid: never,
    locked: never,
  },
  {
    key: "parts",
    store: "shared",
    prompt: "Which parts should the project keep?",
    help: noHelp,
    options: () => [
      { value: "mcp,web", label: "The MCP endpoint and the web app." },
      { value: "mcp", label: "The MCP endpoint only." },
      { value: "web", label: "The web app only." },
    ],
    format: "",
    parse: (value) => {
      const normalized = value.split(",").map((part) => part.trim());
      const sorted = [...new Set(normalized)].toSorted().join(",");
      return choice(["mcp,web", "mcp", "web"])(sorted);
    },
    applies: always,
    appliesWhen: "always",
    needed: always,
    suggest: () => ({ value: "mcp,web", reason: "It keeps everything the template offers." }),
    invalid: never,
    locked: pruneRan,
  },
  {
    key: "sign-in",
    store: "shared",
    prompt: "How should MCP clients sign in?",
    help: noHelp,
    options: () => [
      {
        value: "access",
        label:
          "Cloudflare Access. People sign in through Access. No GitHub app and no Worker secrets.",
      },
      {
        value: "github",
        label:
          "GitHub OAuth. Each person signs in with their GitHub account. Needs a GitHub OAuth app.",
      },
      { value: "bearer", label: "Bearer token. One static token serves a single user." },
    ],
    format: "",
    parse: choice(["access", "github", "bearer"]),
    applies: hasMcp,
    appliesWhen: "the project keeps the MCP endpoint",
    needed: always,
    suggest: (ctx) => ({
      value: "access",
      reason:
        ctx.facts.accessOrganization === null
          ? "It needs no GitHub OAuth app and no Worker secrets. If the account has no Zero Trust organization, setup asks you to create one, which is free."
          : "It needs no GitHub OAuth app and no Worker secrets, and the account already has a Zero Trust organization.",
    }),
    invalid: never,
    locked: pruneRan,
  },
  {
    key: "web-access",
    store: "shared",
    prompt: "Who can open the web app?",
    help: noHelp,
    options: () => [
      { value: "public", label: "Everyone. The web app is public." },
      { value: "private", label: "Only the people you name. Cloudflare Access protects it." },
    ],
    format: "",
    parse: choice(["public", "private"]),
    applies: hasWeb,
    appliesWhen: "the project keeps the web app",
    needed: always,
    suggest: (ctx) =>
      signIn(ctx.answers) === "access"
        ? { value: "private", reason: "One Access application then covers both parts." }
        : { value: "public", reason: "It needs no Access application." },
    invalid: never,
    locked: never,
  },
  {
    key: "who-may-sign-in",
    store: "local",
    prompt: "Who may sign in through Cloudflare Access?",
    help: () => [
      "List email addresses, email domains, or both, separated by commas.",
      "The answer stays in setup.local.json, which Git ignores.",
    ],
    options: () => undefined,
    format: "Comma-separated email addresses or domains, such as ada@example.com,example.com.",
    parse: (value) => {
      const entries = list(value.toLowerCase());
      if (entries.length === 0) {
        return { error: "Name at least one email address or domain." };
      }
      const bad = entries.filter((entry) =>
        entry.includes("@") ? !EMAIL.test(entry) : !HOSTNAME.test(entry),
      );
      if (bad.length > 0) {
        return { error: `These entries aren't email addresses or domains: ${bad.join(", ")}.` };
      }
      return { value: entries.join(",") };
    },
    applies: accessUsed,
    appliesWhen: "the web app is private or MCP clients sign in through Cloudflare Access",
    needed: always,
    suggest: (ctx) => {
      const include = ctx.facts.accessApps.allow?.include ?? [];
      const entries = include.flatMap((rule) =>
        rule.startsWith("email:") || rule.startsWith("domain:") ? [rule.split(":")[1] ?? ""] : [],
      );
      return entries.length === 0
        ? undefined
        : {
            value: entries.join(","),
            reason: "It's the policy of the existing Access application.",
          };
    },
    invalid: never,
    locked: never,
  },
  {
    key: "cloudflare-account",
    store: "shared",
    prompt: "Which Cloudflare account should the project use?",
    help: noHelp,
    options: (ctx) =>
      (ctx.facts.wrangler?.accounts ?? []).map((account) => ({
        value: account.id,
        label: account.name,
      })),
    format: "",
    parse: (value) =>
      ACCOUNT_ID.test(value.trim())
        ? { value: value.trim() }
        : { error: "Use the 32-character account ID." },
    applies: always,
    appliesWhen: "always",
    needed: (ctx) => (ctx.facts.wrangler?.accounts.length ?? 0) > 1,
    suggest: (ctx) => {
      const first = ctx.facts.wrangler?.accounts[0];
      return first === undefined
        ? undefined
        : { value: first.id, reason: "It's the first account that Wrangler lists." };
    },
    invalid: (ctx) => {
      const id = ctx.answers["cloudflare-account"];
      const accounts = ctx.facts.wrangler?.accounts;
      return accounts !== undefined && !accounts.some((account) => account.id === id)
        ? `The Wrangler login can't reach the account ${id ?? ""}.`
        : undefined;
    },
    locked: accountUsed,
  },
  {
    key: "workers-subdomain",
    store: "shared",
    prompt: "Which workers.dev subdomain should the account get?",
    help: (ctx) => [
      "The account has no workers.dev subdomain yet. Previews always run on it, and so does a",
      `Worker without a custom domain, as ${ctx.repo.origin.name}.<subdomain>.workers.dev.`,
      "Every Worker in the account shares it.",
    ],
    options: () => undefined,
    format: "Lowercase letters, digits, and hyphens, such as acme.",
    parse: (value) =>
      NAME_LIKE.test(value.trim())
        ? { value: value.trim() }
        : { error: "Use lowercase letters, digits, and hyphens, up to 63 characters." },
    applies: always,
    appliesWhen: "always",
    needed: (ctx) =>
      ctx.facts.wrangler !== null &&
      accountId(ctx) !== undefined &&
      ctx.facts.workersSubdomain === null,
    suggest: (ctx) => ({
      value: ctx.repo.origin.owner.toLowerCase(),
      reason: "It's the GitHub owner's name.",
    }),
    invalid: never,
    locked: (ctx) =>
      ctx.facts.workersSubdomain === null
        ? undefined
        : `the account already has the subdomain ${ctx.facts.workersSubdomain}`,
  },
  {
    key: "hostname",
    store: "shared",
    prompt: "Which hostname should serve production?",
    help: (ctx) =>
      needsCustomDomain(ctx.answers)
        ? [
            "A private web app next to GitHub OAuth or bearer mode needs a custom domain, because a",
            "bypass application must leave the MCP paths open.",
          ]
        : [],
    options: (ctx) => {
      const subdomain = workersSubdomain(ctx);
      const options: Option[] = needsCustomDomain(ctx.answers)
        ? []
        : [
            {
              value: "workers.dev",
              label: `${ctx.repo.origin.name}.${subdomain ?? "<subdomain>"}.workers.dev`,
            },
          ];
      for (const zone of ctx.facts.zones) {
        options.push({
          value: `${ctx.repo.origin.name}.${zone.name}`,
          label: `A custom domain on the zone ${zone.name}. Any hostname on the zone works.`,
        });
      }
      return options;
    },
    format: "",
    parse: (value) => {
      const trimmed = value.trim().toLowerCase();
      return trimmed === "workers.dev" || HOSTNAME.test(trimmed)
        ? { value: trimmed }
        : { error: "Use workers.dev or a hostname such as tools.example.com." };
    },
    applies: always,
    appliesWhen: "always",
    needed: (ctx) => workersSubdomain(ctx) !== undefined,
    suggest: (ctx) => {
      const zone = ctx.facts.zones[0];
      if (needsCustomDomain(ctx.answers)) {
        return zone === undefined
          ? undefined
          : {
              value: `${ctx.repo.origin.name}.${zone.name}`,
              reason: "This combination needs a custom domain, and the account has this zone.",
            };
      }
      return { value: "workers.dev", reason: "It needs no zone and no DNS setup." };
    },
    invalid: (ctx) => {
      const value = ctx.answers.hostname;
      if (value === undefined) {
        return undefined;
      }
      if (!customDomain(ctx.answers)) {
        return needsCustomDomain(ctx.answers)
          ? "A private web app next to GitHub OAuth or bearer mode needs a custom domain."
          : undefined;
      }
      return zoneFor(ctx, value) === undefined
        ? `${value} isn't on a zone in the account ${accountLabel(ctx)}.`
        : undefined;
    },
    locked: hostUsed,
  },
  {
    key: "allowed-github",
    store: "shared",
    prompt: "Which GitHub accounts may sign in to the MCP endpoint?",
    help: () => ["List GitHub logins or numeric user IDs, separated by commas, or * for everyone."],
    options: () => undefined,
    format: "Comma-separated GitHub logins or user IDs, or *.",
    parse: (value) => {
      const trimmed = value.trim();
      if (trimmed === "*") {
        return { value: trimmed };
      }
      const entries = list(trimmed);
      if (entries.length === 0 || entries.some((entry) => !GITHUB_LOGIN.test(entry))) {
        return { error: "Use GitHub logins or numeric user IDs, separated by commas, or *." };
      }
      return { value: entries.join(",") };
    },
    applies: (answers) => signIn(answers) === "github",
    appliesWhen: "MCP clients sign in with GitHub",
    needed: always,
    suggest: (ctx) =>
      ctx.facts.github === null
        ? undefined
        : { value: ctx.facts.github.login, reason: "It's the account that the GitHub CLI uses." },
    invalid: never,
    locked: never,
  },
  {
    key: "oauth-previews",
    store: "shared",
    prompt: "Should pull request Previews support MCP sign-in?",
    help: () => [
      "It needs a second GitHub OAuth app with a wildcard callback. Without it, Previews still",
      "deploy and pass their checks, but MCP sign-in on a Preview fails.",
    ],
    options: () => [
      { value: "yes", label: "Yes. Create a second GitHub OAuth app for Previews." },
      { value: "no", label: "No. Previews deploy without MCP sign-in." },
    ],
    format: "",
    parse: choice(["yes", "no"]),
    applies: (answers) => signIn(answers) === "github",
    appliesWhen: "MCP clients sign in with GitHub",
    needed: always,
    suggest: () => ({ value: "no", reason: "It saves the person one more OAuth app." }),
    invalid: never,
    locked: never,
  },
  {
    key: "license",
    store: "shared",
    prompt: "Which license should the project use?",
    help: () => ["The template uses MIT No Attribution (MIT-0)."],
    options: () => [
      { value: "mit-0", label: "Keep MIT No Attribution (MIT-0)." },
      { value: "mit", label: "The MIT License, with the GitHub owner as the copyright holder." },
      { value: "none", label: "No license. All rights reserved." },
    ],
    format: "",
    parse: choice(["mit-0", "mit", "none"]),
    applies: always,
    appliesWhen: "always",
    needed: always,
    suggest: () => ({ value: "mit-0", reason: "It's the template's license." }),
    invalid: never,
    locked: never,
  },
  {
    key: "access-otp",
    store: "shared",
    prompt: "Should people sign in with a one-time PIN sent to their email?",
    help: () => [
      "The Zero Trust organization has only the Cloudflare login method, which admits only",
      "members of the Cloudflare account. The one-time PIN login method admits anyone that the",
      "Access policy names.",
    ],
    options: () => [
      { value: "yes", label: "Yes. Add the one-time PIN login method." },
      { value: "no", label: "No. Only members of the Cloudflare account can sign in." },
    ],
    format: "",
    parse: choice(["yes", "no"]),
    applies: accessUsed,
    appliesWhen: "the web app is private or MCP clients sign in through Cloudflare Access",
    needed: (ctx) => {
      const org = ctx.facts.accessOrganization;
      return org !== null && org.onlyCloudflareLogin && !org.hasOneTimePin;
    },
    suggest: () => ({
      value: "yes",
      reason: "Without it, people outside the Cloudflare account can't sign in.",
    }),
    invalid: never,
    locked: never,
  },
];

/** Looks up a question by key. */
export function question(key: QuestionKey): QuestionSpec {
  const spec = QUESTIONS.find((candidate) => candidate.key === key);
  if (spec === undefined) {
    throw new Error(`Unknown question ${key}.`);
  }
  return spec;
}

/** The values that each answer to a person task accepts. */
export const TASK_ANSWERS: Record<"mcp-client" | "renovate", string[]> = {
  "mcp-client": ["done", "not-now", "failed"],
  renovate: ["done", "not-now"],
};

/** The result of checking an answer before the script records it. */
export type AnswerCheck =
  | { ok: true; key: AnswerKey; value: string; store: "shared" | "local" }
  | { ok: false; reason: string };

const SETTLED: Record<string, string> = {
  name: "The project name comes from the origin remote, so it was settled when the repository was created. To use another name, create a new repository from the template.",
  owner:
    "The GitHub owner comes from the origin remote, so it was settled when the repository was created. To use another owner, create a new repository from the template.",
};

/**
 * The checks that need no context: the key must exist and the value must parse. `answer` runs
 * these before it probes anything, so a typo gets its answer at once.
 */
export function precheckAnswer(
  key: string,
  raw: string,
): { ok: true; spec: QuestionSpec | undefined; value: string } | { ok: false; reason: string } {
  const settled = SETTLED[key];
  if (settled !== undefined) {
    return { ok: false, reason: settled };
  }
  if (key === "mcp-client" || key === "renovate") {
    const values = TASK_ANSWERS[key];
    return values.includes(raw)
      ? { ok: true, spec: undefined, value: raw }
      : { ok: false, reason: `The ${key} answer is one of: ${values.join(", ")}.` };
  }
  const spec = QUESTIONS.find((candidate) => candidate.key === key);
  if (spec === undefined) {
    const keys = [...QUESTIONS.map((candidate) => candidate.key), "mcp-client", "renovate"];
    return {
      ok: false,
      reason: `There's no question named ${key}. The keys are: ${keys.join(", ")}.`,
    };
  }
  const parsed = spec.parse(raw);
  if ("error" in parsed) {
    return { ok: false, reason: `That isn't a valid ${key} answer. ${parsed.error}` };
  }
  return { ok: true, spec, value: parsed.value };
}

/**
 * Checks an answer: the key must exist, the value must parse, the question must apply to the
 * answers so far, and a step must not have used the earlier answer already.
 */
export function checkAnswer(key: string, raw: string, ctx: Context): AnswerCheck {
  const pre = precheckAnswer(key, raw);
  if (!pre.ok) {
    return pre;
  }
  const { spec } = pre;
  if (spec === undefined) {
    if (key === "mcp-client" && !hasMcp(ctx.answers)) {
      return {
        ok: false,
        reason: "The project has no MCP endpoint, so there's no client to connect.",
      };
    }
    return {
      ok: true,
      key: key === "mcp-client" ? "mcp-client" : "renovate",
      value: raw,
      store: "local",
    };
  }
  const parsed = { value: pre.value };
  if (!spec.applies(ctx.answers)) {
    return {
      ok: false,
      reason: `The ${key} question applies only when ${spec.appliesWhen}, which the answers so far don't say.`,
    };
  }
  const previous = ctx.answers[spec.key];
  if (previous !== undefined && previous !== parsed.value) {
    const reason = spec.locked(ctx);
    if (reason !== undefined) {
      return {
        ok: false,
        reason: `The ${key} answer can't change from ${previous}, because ${reason}. To use another value, start again from a new repository created from the template.`,
      };
    }
  }
  if (key === "hostname" && parsed.value === "workers.dev" && needsCustomDomain(ctx.answers)) {
    return {
      ok: false,
      reason:
        "A private web app next to GitHub OAuth or bearer mode needs a custom domain, because a bypass application must leave the MCP paths open. Name a hostname on one of the account's zones, or make the web app public.",
    };
  }
  return { ok: true, key: spec.key, value: parsed.value, store: spec.store };
}
