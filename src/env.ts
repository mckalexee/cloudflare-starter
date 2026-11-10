// Types and constants that describe the MCP caller, shared by the MCP server and the auth
// code. The Worker bindings themselves come from `worker-configuration.d.ts`, which
// `wrangler types` generates from `wrangler.jsonc`.

// @starter:oauth
// The OAuth provider advertises `SCOPES` to clients, and the consent page shows each scope's entry
// in `SCOPE_DESCRIPTIONS` to the person who approves it.
// @starter:end

/**
 * Every scope this server grants. A tool that declares a scope runs only when the caller holds it.
 */
export const SCOPES = ["profile"] as const;

/** One of the scopes in `SCOPES`. */
export type Scope = (typeof SCOPES)[number];

/**
 * What each scope lets a client do, in words for a person. Describe what the scope allows rather
 * than what today's tools do with it, so the text stays true as tools change.
 * `Record<Scope, string>` makes a scope without a description a type error.
 */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  // @starter:oauth
  profile: "See your GitHub login and name.",
  // @starter:end
};

// @starter:oauth
// With GitHub OAuth, `id` is the GitHub account ID as text, `login` and `name` come from the same
// account, and the caller passed the `ALLOWED_GITHUB_LOGINS` check at sign-in and again at each
// token refresh. Bearer mode uses the ID `"0"` for its one user.
// @starter:end
// @starter:access
// With Cloudflare Access sign-in, `id` and `login` are the email address that Access verified, in
// lowercase.
// @starter:end

/**
 * The caller as MCP tools see it: an account ID, a login, a display name, and the scopes
 * granted to the current token. It's a type alias rather than an interface so that it fits the
 * plain record that `getMcpAuthContext()` carries. Never log it or return it whole from a tool.
 */
export type AuthProps = {
  /**
   * The user's account ID as text. Key per-user data by it, because in some sign-in modes the
   * login can change while the ID stays the same.
   */
  id: string;
  login: string;
  name: string;
  scopes: string[];
  // @starter:oauth
  // With GitHub OAuth, `accessToken` is the user's GitHub token, which the OAuth provider stores
  // encrypted with the grant. Bearer mode never sets it.
  // @starter:end
  /**
   * An upstream access token, which tools use to call an API on the user's behalf. Never log it
   * or return it from a tool.
   */
  accessToken?: string;
};
