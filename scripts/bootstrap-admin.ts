import { loadEnvConfig } from "@next/env";
import { hashPassword } from "@/lib/auth/password";
import { loadBootstrapConfig, loadGatewayConfig } from "@/lib/config-core";
import { createPostgresDatabase } from "@/lib/server/db/client";
import { createGatewayRepository } from "@/lib/server/db/repository";

async function main() {
  loadEnvConfig(process.cwd());
  const gatewayConfig = loadGatewayConfig(process.env);
  const bootstrapConfig = loadBootstrapConfig(process.env);
  const database = createPostgresDatabase(gatewayConfig.databaseUrl);

  try {
    const repository = createGatewayRepository(database, gatewayConfig.orderTokenSecret);
    await repository.createAdmin(bootstrapConfig.email, hashPassword(bootstrapConfig.password));
    process.stdout.write(
      `Created the first administrator for ${bootstrapConfig.email}. Remove BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD from the environment now.\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Administrator bootstrap failed: ${message}\n`);
  process.exitCode = 1;
});
