import type { ColumnType, Generated } from 'kysely';
type Timestamp = ColumnType<Date, Date | string, Date | string>;
export interface BillingDB {
  accounts: {
    owner_id: string;
    email: string;
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
  };
  subscriptions: {
    id: string;
    owner_id: string;
    price_id: string;
    status: string;
    period_end: Timestamp;
    trial_end: Timestamp | null;
    cancel_at_period_end: boolean;
    updated_at: Timestamp;
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
