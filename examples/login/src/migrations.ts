import { defaultMigrations } from 'pgstencil/database';
import { billingMigrations } from '@pgstencil/stripe/migrations';
/** Every SQL source this example needs, in dependency order. */
export const appMigrations = [defaultMigrations, billingMigrations];
