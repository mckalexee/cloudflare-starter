// Health check route. Deploy and preview workflows poll it to confirm that a release serves
// traffic, so it stays cheap and touches no bindings.
import { Hono } from "hono";

/** Routes for `GET /healthz`. */
export const healthRoutes = new Hono<{ Bindings: Env }>().get("/healthz", (c) =>
  c.json({ ok: true }),
);
