// Setup file that applies the D1 migrations to `DB` before each test file runs. Each test file
// gets its own storage, so every file starts from an empty database with the current schema.
// `vitest.config.ts` reads the migrations in Node and passes them as the `TEST_MIGRATIONS`
// binding, because this file runs in workerd, which can't read the file system.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

declare global {
  namespace Cloudflare {
    // Only tests bind `TEST_MIGRATIONS`, so `wrangler types` doesn't generate it.
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
