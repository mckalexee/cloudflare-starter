// Tests for the D1 binding and the setup file that migrates it. They hold with no migrations, so
// they keep passing as `migrations/` grows.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("DB", () => {
  it("records every migration as applied", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").run<{
      name: string;
    }>();

    expect(results.map((row) => row.name)).toEqual(
      env.TEST_MIGRATIONS.map((migration) => migration.name),
    );
  });
});
