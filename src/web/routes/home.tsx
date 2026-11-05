// Home page. It shows the app name from the Worker's vars to prove that loaders can read bindings.
import { cloudflareContext } from "#web/context.ts";

import type { Route } from "./+types/home.ts";

/** Gives the page its app name from the Worker vars, which shows that loaders can read bindings. */
export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { appName: env.APP_NAME };
}

/** Page title for the home route. */
export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData.appName }];
}

/** Home page body. */
export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>{loaderData.appName}</h1>
    </main>
  );
}
