import type { ColumnType, Generated } from 'kysely';
type Timestamp = ColumnType<Date, Date | string, Date | string>;
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
