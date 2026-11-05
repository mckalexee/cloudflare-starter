// Types and constants that describe the signed-in caller, shared by the MCP server and the auth
// code. The Worker bindings themselves come from `worker-configuration.d.ts`, which
// `wrangler types` generates from `wrangler.jsonc`.

/**
 * Every OAuth scope this server grants. The OAuth provider advertises this list, and a tool that
 * declares a scope runs only when the caller's token carries it.
 */
export const SCOPES = ["profile"] as const;

/** One of the scopes in `SCOPES`. */
export type Scope = (typeof SCOPES)[number];

/**
 * What each scope lets a client do, in words for the person who approves it on the consent page.
 * Describe what the scope allows rather than what today's tools do with it, so the text stays
 * true as tools change. `Record<Scope, string>` makes a scope without a description a type error.
 */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  profile: "See your GitHub login and name.",
};

/**
 * The caller as MCP tools see it: a numeric account ID, a GitHub login, a display name, and the
 * scopes granted to the current token. In OAuth mode, the caller passed the
 * `ALLOWED_GITHUB_LOGINS` check at sign-in and again at each token refresh. It's a type alias
 * rather than an interface so that it fits the plain record that `getMcpAuthContext()` carries.
 * Never log it or return it whole from a tool.
 */
export type AuthProps = {
  /**
   * The user's numeric GitHub account ID, which never changes. Key per-user data by it, because
   * the user can rename their login on GitHub. Bearer mode uses `0` for its one user.
   */
  id: number;
  login: string;
  name: string;
  scopes: string[];
  /**
   * The user's GitHub access token, which tools use to call the GitHub API on the user's behalf.
   * The OAuth provider stores it encrypted with the grant. It's absent in bearer mode.
   * Never log it or return it from a tool.
   */
  accessToken?: string;
};
