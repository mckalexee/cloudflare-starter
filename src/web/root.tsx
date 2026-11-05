// Root route of the web app. It owns the HTML document shell, the navigation, the identity gate
// that keeps private routes private, and the error page that every route renders inside.
import type { ReactNode } from "react";
import {
  type ErrorResponse,
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import { requireIdentityMiddleware } from "#web/middleware.ts";

import type { Route } from "./+types/root.ts";

// Route patterns that anyone may see on a private site, written the way React Router reports
// them, such as `/` or `/blog/:slug`. Every other route needs a Cloudflare Access identity, so a
// new route stays private until you add it here.
const PUBLIC_PATHS = new Set(["/"]);

/** Runs the identity gate for every route that isn't in the public list. */
export const middleware: Route.MiddlewareFunction[] = [
  (args, next) => (PUBLIC_PATHS.has(args.pattern) ? next() : requireIdentityMiddleware(args, next)),
];

/** Document shell shared by every route, including error boundaries. */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <Meta />
        <Links />
      </head>
      <body>
        <nav>
          <Link to="/">Home</Link> <Link to="/account">Account</Link>
        </nav>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** Renders the matched child route. */
export default function App() {
  return <Outlet />;
}

// Fixed text for common statuses. The status text of a thrown response isn't used, because
// `data()` leaves it to the runtime, which can report a 403 as "Internal Server Error".
const STATUS_MESSAGES: Record<number, string> = {
  400: "The request isn't valid.",
  401: "Sign in to see this page.",
  403: "You don't have access to this page.",
  404: "This page doesn't exist.",
};

// A route that throws `data({ message }, { status })` chose that message for the person reading
// the page, so it wins over the fixed text.
function messageFor(error: ErrorResponse): string {
  const body: unknown = error.data;
  if (typeof body === "object" && body !== null && "message" in body) {
    const { message } = body;
    if (typeof message === "string") {
      return message;
    }
  }
  return STATUS_MESSAGES[error.status] ?? "The request failed.";
}

/**
 * Error page for every route. For a thrown response, it shows the status and the message that
 * the route supplied, or fixed text for the status. Anything else gets a generic message, so that
 * internal errors never reach the browser.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  if (isRouteErrorResponse(error)) {
    return (
      <main>
        <h1>{error.status}</h1>
        <p>{messageFor(error)}</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Error</h1>
      <p>Something went wrong.</p>
    </main>
  );
}
