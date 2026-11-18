import { loadEnvConfig } from "@next/env";
import { createPostgresDatabase } from "@/lib/server/db/client";
import { runMigrations } from "@/lib/server/db/migrations";

async function main() {
  loadEnvConfig(process.cwd());
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to run migrations");

  const database = createPostgresDatabase(connectionString);
  try {
    const applied = await runMigrations(database);
    if (applied.length === 0) {
      process.stdout.write("Database schema is already current.\n");
    } else {
      process.stdout.write(`Applied migrations: ${applied.join(", ")}\n`);
    }
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown migration error";
  process.stderr.write(`Database migration failed: ${message}\n`);
  process.exitCode = 1;
});
