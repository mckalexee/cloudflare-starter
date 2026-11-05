// The `ALLOWED_GITHUB_LOGINS` policy: who may sign in and keep refreshing tokens. The GitHub
// callback checks it at sign-in, and the OAuth provider checks it again on every refresh, so
// removing someone from the list cuts off their existing grants at the next refresh.

/** The GitHub account to check: its login and its numeric account ID as a string. */
export type GitHubAccount = { login: string; id: string };

/**
 * Returns whether `ALLOWED_GITHUB_LOGINS` admits a GitHub account. An empty value admits no one,
 * so a fresh deployment stays closed until you choose who may use it. The value `*` admits every
 * GitHub account. Anything else is a comma-separated list of logins, numeric GitHub user IDs, or
 * both. Entries are trimmed and compared without case, because GitHub logins are
 * case-insensitive. An entry matches a login or an ID with that exact text.
 */
export function isAllowedGitHubAccount(value: string, account: GitHubAccount): boolean {
  const trimmed = value.trim();
  if (trimmed === "*") {
    return true;
  }
  const entries = new Set(
    trimmed
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ""),
  );
  return entries.has(account.login.toLowerCase()) || entries.has(account.id);
}
