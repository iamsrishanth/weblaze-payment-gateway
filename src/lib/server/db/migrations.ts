import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TransactionalDatabase } from "@/lib/server/db/client";

export async function runMigrations(
  database: TransactionalDatabase,
  migrationDirectory = path.join(process.cwd(), "db", "migrations"),
): Promise<string[]> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort((left, right) => left.localeCompare(right));
  const applied: string[] = [];

  for (const file of files) {
    const version = file.slice(0, -4);
    const sql = await readFile(path.join(migrationDirectory, file), "utf8");
    const wasApplied = await database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('weblaze-payment-gateway-schema'))");
      const existing = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1 FOR UPDATE",
        [version],
      );
      if (existing.rowCount > 0) return false;
      const statements = sql
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await client.query(statement);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      return true;
    });
    if (wasApplied) applied.push(version);
  }

  return applied;
}
