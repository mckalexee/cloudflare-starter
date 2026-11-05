// React Router framework configuration. The app renders on the server inside the Worker, and its
// route modules live in `src/web` so they stay apart from the Hono layer in `src/http`.
import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  appDirectory: "src/web",
} satisfies Config;
