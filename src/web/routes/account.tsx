// Account page. It shows who is signed in through Cloudflare Access, and it is the worked example
// of a private route in the web app. It isn't in the root route's list of public paths, so the
// identity gate runs before its loader.
import { identityContext } from "#web/context.ts";

import type { Route } from "./+types/account.ts";

/** Reads the identity that the identity gate resolved for this request. */
export function loader({ context }: Route.LoaderArgs) {
  return { identity: context.get(identityContext) };
}

/** Page title for the account route. */
export function meta() {
  return [{ title: "Account" }];
}

/** Account page body. */
export default function Account({ loaderData }: Route.ComponentProps) {
  const { identity } = loaderData;
  return (
    <main>
      <h1>Account</h1>
      {identity ? (
        <dl>
          <dt>Email</dt>
          <dd>{identity.email}</dd>
          {identity.name ? (
            <>
              <dt>Name</dt>
              <dd>{identity.name}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p>
          This site is public, and nobody is signed in. To require sign-in, protect the site with
          Cloudflare Access, set <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code>, and
          set <code>WEB_ACCESS</code> to <code>private</code>.
        </p>
      )}
    </main>
  );
}
