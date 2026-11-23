// The list of route patterns that anyone may see on a private site, and the check that the root
// route's identity gate runs against it. Every other route needs a Cloudflare Access identity.

/**
 * Route patterns that anyone may see on a private site, such as `/` for the home page or
 * `blog/:slug`. The list ships empty, so every page of a private site is private until you list
 * it, including a page that replaces the home page.
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set<string>([]);

/**
 * Reports whether `pattern`, as React Router reports it, appears in `list`. React Router joins
 * the paths from `src/web/routes.ts`, so it reports `route("blog/:slug", ...)` as `blog/:slug`,
 * without a leading slash, and the index route as `/`. An entry matches with or without a leading
 * slash, so both `/blog/:slug` and `blog/:slug` work.
 */
export function matchesPublicPath(list: Iterable<string>, pattern: string): boolean {
  const target = withoutLeadingSlash(pattern);
  for (const entry of list) {
    if (withoutLeadingSlash(entry) === target) {
      return true;
    }
  }
  return false;
}

/** Reports whether anyone may see the route with `pattern` on a private site. */
export function isPublicPath(pattern: string): boolean {
  return matchesPublicPath(PUBLIC_PATHS, pattern);
}

// Keeps a lone `/`, so the index route's pattern doesn't become the empty string.
function withoutLeadingSlash(pattern: string): string {
  return pattern.length > 1 && pattern.startsWith("/") ? pattern.slice(1) : pattern;
}
