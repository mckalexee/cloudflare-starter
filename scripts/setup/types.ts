// The shapes that the setup script's modules share: the answers, the facts that the probes read
// from the repository and the accounts, the cached local state, and the actions that the planner
// returns. Keeping them in one module lets the planner stay a pure function of these values.

/** A part of the template that a project can keep. */
export type Part = "mcp" | "web";

/** How MCP clients sign in. */
export type SignIn = "github" | "bearer" | "access";

/** The keys of the questions that the script asks the person. */
export type QuestionKey =
  | "brief"
  | "display-name"
  | "description"
  | "parts"
  | "sign-in"
  | "web-access"
  | "who-may-sign-in"
  | "cloudflare-account"
  | "workers-subdomain"
  | "hostname"
  | "allowed-github"
  | "oauth-previews"
  | "license"
  | "access-otp"
  | "existing-resources";

/** The keys of the two last person tasks, whose result is the person's answer. */
export type TaskAnswerKey = "mcp-client" | "renovate";

/** Every key that `node scripts/setup.ts answer` accepts. */
export type AnswerKey = QuestionKey | TaskAnswerKey;

/** Recorded answers by key. Lists, such as allowed GitHub accounts, are comma-separated text. */
export type Answers = Partial<Record<AnswerKey, string>>;

/** A Cloudflare account that a login can reach. */
export type Account = { id: string; name: string };

/** A zone in the chosen Cloudflare account. */
export type Zone = { id: string; name: string };

/**
 * An Access application as the probes read it back. `destinations` holds the hostnames and paths
 * that it covers, and `include` the allow rules of its policy in the form `email:<address>`,
 * `domain:<domain>`, or `everyone`.
 */
export type AccessAppFact = {
  id: string;
  aud: string;
  domain: string;
  destinations: string[];
  include: string[];
  managedOAuth: boolean;
};

/** The production deploy run for `HEAD`. `pending` covers a run that hasn't started or finished. */
export type DeployFact = {
  url: string;
  status: "pending" | "success" | "failure";
  /** How many times the deploy job ran for `HEAD`, reruns included. */
  attempts: number;
  /** The workflow run's ID, for a rerun or its log. */
  runId: number;
  /** The deploy job's conclusion, such as `skipped`, when it didn't succeed. */
  conclusion?: string;
};

/** One live check against the deployed Worker. */
export type LiveCheck = { name: string; ok: boolean; detail: string };

/**
 * What the remote probes read from GitHub and Cloudflare on every run. `SETUP_FIXTURE` replaces
 * all of it with fixed values. A probe whose prerequisites are missing, such as a login, returns
 * the empty value for its field.
 */
export type RemoteFacts = {
  /** The account that `gh auth status` reports, or `null` when the GitHub CLI isn't signed in. */
  github: { login: string } | null;
  /** The accounts that `wrangler whoami` lists, or `null` when Wrangler isn't signed in. */
  wrangler: { accounts: Account[]; email?: string } | null;
  /** The accounts that `cf auth whoami` lists, or `null` when the Cloudflare CLI isn't signed in. */
  cf: { accountIds: string[]; email?: string } | null;
  /** The GitHub repository named by the `origin` remote, or `null` when it can't be read. */
  repository: { description: string } | null;
  /** The account's `workers.dev` subdomain, or `null` when the account has none. */
  workersSubdomain: string | null;
  /** The zones in the chosen account. */
  zones: Zone[];
  /** The account's Zero Trust organization, or `null` when it has none. */
  accessOrganization: {
    teamDomain: string;
    /** Whether the only login method is the one that admits members of the Cloudflare account. */
    onlyCloudflareLogin: boolean;
    hasOneTimePin: boolean;
  } | null;
  /** The IDs of the project's KV namespaces, `<name>-kv` and `<name>-kv-preview`. */
  kvNamespaces: { production: string | null; preview: string | null };
  /** The project's Access applications: the allow application and the bypass application. */
  accessApps: { allow: AccessAppFact | null; bypass: AccessAppFact | null };
  /** Whether GitHub accepts the client ID and secret in `.dev.vars`, or `null` before a check. */
  githubOAuth: { production: boolean | null; preview: boolean | null };
  /** Whether the API token file exists, and whether Cloudflare accepts the token in it. */
  apiToken: { saved: boolean; valid: boolean | null };
  /** The secret names on the production Worker, or `null` when the Worker doesn't exist. */
  workerSecrets: string[] | null;
  /** The secret names in the Preview base config. */
  previewSecrets: string[];
  /** The repository secret names. */
  githubSecrets: string[];
  /** The repository variables by name. */
  githubVariables: Record<string, string>;
  /** Whether `origin/main` equals the local `HEAD`. */
  pushed: boolean;
  /** The deploy run for `HEAD`, or `null` when there's none yet. */
  deploy: DeployFact | null;
  /** The live checks against the deployed Worker, or `null` before they ran. */
  live: LiveCheck[] | null;
  /** The Worker named after the project, by its script tag, or `null` when there's none. */
  worker: { tag: string } | null;
  /** Whether this repository's deploy job ever succeeded, which makes the Worker its own. */
  repoDeployed: boolean;
};

/**
 * The IDs of the resources that setup created or adopted, from `setup.json`. A resource with the
 * project's name but another ID belongs to something else until the person says otherwise.
 */
export type Resources = {
  kvProduction?: string;
  kvPreview?: string;
  accessAllow?: string;
  accessBypass?: string;
  worker?: string;
};

/** What the parts of the template that remain in the working tree say about earlier steps. */
export type TreeFacts = {
  parts: Part[];
  signIn: SignIn | null;
  /** Whether nothing has been pruned yet: both parts and GitHub OAuth are present. */
  pristine: boolean;
};

/** The places where a secret value lives: on the Worker, in the Preview base config, or in GitHub. */
export type SecretTarget = "production" | "preview" | "apiToken";

/** What the local probes read from the repository on every run. These never come from a fixture. */
export type RepoFacts = {
  root: string;
  /** The owner and name from the `origin` remote. */
  origin: { owner: string; name: string };
  /** The Wrangler version that `package.json` pins, for commands that run before the install. */
  wranglerVersion: string;
  agentsBlock: boolean;
  /** Files that still name the template. */
  renameLeftovers: string[];
  tree: TreeFacts;
  installed: boolean;
  /** The hostname that `wrangler.jsonc` names in a route or in `MCP_RESOURCE`, if any. */
  configuredHost: string | null;
  /** Files that the config step would still change. */
  configPending: string[];
  /** For each key in `.dev.vars`, whether it has a value. */
  devVars: Partial<Record<string, boolean>>;
  /** Hashes of the current source values of each secret target, or `null` without a source. */
  secretSources: Record<SecretTarget, string | null>;
  /** Whether `pnpm verify` passed on the working tree as it is now. */
  verified: boolean;
  /** Whether `git status` shows no changes. */
  clean: boolean;
  /** The file outside the repository where the person saves the Cloudflare API token. */
  apiTokenFile: string;
  /** The Git author email, as a suggestion for who may sign in. */
  gitEmail: string | null;
};

/** What the script keeps in `setup.local.json`, which Git ignores. */
export type LocalState = {
  /** Answers that mustn't be committed: who may sign in and the two last tasks. */
  answers: Answers;
  /** Hashes of the secret values that the script uploaded last, by target. */
  secretHashes: Partial<Record<SecretTarget, string>>;
  /** A hash of the manifests that the last install ran with. */
  installedFor?: string;
  /** A hash of the working tree that `pnpm verify` passed on last. */
  verifiedFingerprint?: string;
  /** Whether the script printed the summary of what it creates. */
  summaryShown?: boolean;
  /** Remote steps that fixture mode skipped, which count as done in fixture mode only. */
  fixtureSkipped?: string;
  /** Hashes of secret values that GitHub or Cloudflare accepted, so they aren't checked again. */
  validated?: string;
};

/** Everything the planner reads. */
export type Context = {
  resources: Resources;
  /** The answers from `setup.json` and `setup.local.json`, merged. */
  answers: Answers;
  local: LocalState;
  repo: RepoFacts;
  facts: RemoteFacts;
  fixture: boolean;
};

/** The person tasks, in the order the planner presents them. */
export type TaskId =
  | "login-github"
  | "login-wrangler"
  | "login-cf"
  | "zero-trust-org"
  | "github-oauth-app"
  | "github-oauth-app-previews"
  | "cloudflare-api-token"
  | "mcp-client"
  | "renovate"
  | "new-name";

/** The work steps, local and remote, in the order the planner runs them. */
export type StepId =
  | "summary"
  | "agents-block"
  | "rename"
  | "prune"
  | "install"
  | "workers-subdomain"
  | "kv-namespaces"
  | "access-otp"
  | "access-apps"
  | "config"
  | "dev-vars"
  | "verify"
  | "commit"
  | "worker-secrets"
  | "preview-secrets"
  | "github-secrets"
  | "github-variables"
  | "repository-description"
  | "push"
  | "deploy-rerun"
  | "deploy-failed"
  | "live-checks";

/** The one thing that a run of the script does or asks for. */
export type Action =
  | { kind: "question"; key: QuestionKey; problem: string | undefined }
  | {
      kind: "task";
      id: TaskId;
      remaining: number;
      /** Whether one more task may follow, because the Zero Trust organization isn't known yet. */
      maybeMore: boolean;
    }
  | { kind: "step"; id: StepId; remote: boolean }
  | { kind: "wait"; id: "deploy"; url: string | undefined }
  | { kind: "done"; skipped: StepId[] };
