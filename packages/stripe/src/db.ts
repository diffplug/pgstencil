import type {
  ColumnType,
  Generated,
  InsertType,
  SelectType,
  UpdateType,
} from 'kysely';
import type { DB as Migrated } from './db.generated.ts';
type Timestamp = ColumnType<Date, Date | string, Date | string>;
/**
 * The billing schema as consumers see it. Written by hand so its columns carry
 * documentation and the `owner_access` view keeps the non-null columns
 * Postgres cannot declare for a view. `db.generated.ts`, generated from the
 * migrations by `pgstencil types` and checked by `pgstencil verify`, keeps it
 * honest: `BillingDBMatchesMigrations` below fails typechecking on any drift.
 */
export interface BillingDB {
  accounts: {
    owner_id: string;
    /** Null when the owner has none; Stripe Checkout then collects one. */
    email: string | null;
    created_at: Timestamp;
    trial_used_at: Timestamp | null;
    customer_id: string | null;
    customer_key: string | null;
    customer_started_at: Timestamp | null;
  };
  checkouts: {
    id: string;
    owner_id: string;
    plan: string;
    price_id: string;
    trial_days: number;
    status: string;
    session_id: string | null;
    url: string | null;
    created_at: Timestamp;
    expires_at: Timestamp;
    /** The caller's attribution label; null when none was given. */
    ref: string | null;
  };
  subscriptions: {
    id: string;
    owner_id: string;
    price_id: string;
    status: string;
    /** Null on rows synchronized before migration 004, until the next sync. */
    started_at: Timestamp | null;
    ended_at: Timestamp | null;
    period_end: Timestamp;
    trial_end: Timestamp | null;
    cancel_at_period_end: boolean;
    updated_at: Timestamp;
    /** The reason `Billing.end` recorded; null for a subscription it did not end. */
    end_reason: string | null;
  };
  /**
   * Migration 007's view: one row per owner holding exactly one current
   * subscription. Access at time T is `access_until > T`.
   */
  owner_access: {
    owner_id: string;
    subscription_id: string;
    price_id: string;
    status: string;
    /** When this subscription stops granting access; null when its status grants none. */
    access_until: Date | null;
  };
  events: {
    id: string;
    type: string;
    received_at: Timestamp;
    processed_at: Timestamp | null;
    attempts: Generated<number>;
    failed: Generated<boolean>;
  };
}

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
/** Views whose hand-written columns may be narrower than what Postgres reports. */
type Views = 'owner_access';
/** A column as Kysely uses it: what a select returns, an insert takes, an update takes. */
type Facets<T> = [SelectType<T>, InsertType<T>, UpdateType<T>];
/** `true` where a column agrees; otherwise both types, so the error names it. */
type Agreement<Table, Hand, Generated> = (
  Table extends Views
    ? [SelectType<Hand>] extends [SelectType<Generated>]
      ? true
      : false
    : Same<Facets<Hand>, Facets<Generated>>
) extends true
  ? true
  : { BillingDB: Hand; 'db.generated.ts': Generated };
type Columns<Table, Hand, Generated> = {
  [Column in keyof Hand | keyof Generated]: Column extends keyof Hand
    ? Column extends keyof Generated
      ? Agreement<Table, Hand[Column], Generated[Column]>
      : 'column missing from db.generated.ts'
    : 'column missing from BillingDB';
};
type Drift = {
  [Table in keyof BillingDB | keyof Migrated]: Table extends keyof BillingDB
    ? Table extends keyof Migrated
      ? Columns<Table, BillingDB[Table], Migrated[Table]>
      : 'table missing from db.generated.ts'
    : 'table missing from BillingDB';
};
type Agrees<T extends Record<string, Record<string, true>>> = T;
// Never used: checking the constraint is the point. `pnpm typecheck` runs it.
type BillingDBMatchesMigrations = Agrees<Drift>;
