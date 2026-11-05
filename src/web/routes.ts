// Route table for the web app. Each entry maps a URL pattern to a module in `src/web/routes`.
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("account", "routes/account.tsx"),
] satisfies RouteConfig;
