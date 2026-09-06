import { fileURLToPath } from 'node:url';
export const authMigrations = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);
