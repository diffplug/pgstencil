import { fileURLToPath } from 'node:url';
export const billingMigrations = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);
