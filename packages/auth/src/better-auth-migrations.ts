import { fileURLToPath } from 'node:url';
export const betterAuthMigrations = fileURLToPath(
  new URL('../better-auth-migrations/', import.meta.url),
);
