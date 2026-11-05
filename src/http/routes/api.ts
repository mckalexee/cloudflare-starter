// JSON API routes, mounted under `/api`. `GET /api/me` is the worked example of a private route:
// `requireIdentity()` rejects requests without an identity when the site is private. The routes
// belong to the web half, because they depend on Cloudflare Access identity.
import { Hono } from "hono";

import { type AccessEnv, requireIdentity } from "#http/access.ts";

/** Routes mounted under `/api`. */
export const apiRoutes = new Hono<AccessEnv>().get("/me", requireIdentity(), (c) =>
  c.json({ identity: c.get("identity") }),
);
