import { betterAuthMigrations } from '@pgstencil/auth/better-auth-migrations';
import { billingMigrations } from '@pgstencil/stripe/migrations';
/** Every SQL source this example needs, in dependency order. */
export const appMigrations = [betterAuthMigrations, billingMigrations];
