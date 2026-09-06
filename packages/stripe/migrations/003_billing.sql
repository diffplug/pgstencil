-- Up Migration
CREATE SCHEMA pgstencil_billing;
CREATE TABLE pgstencil_billing.accounts (
  owner_id text PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL,
  trial_used_at timestamptz,
  customer_id text UNIQUE,
  customer_key text,
  customer_started_at timestamptz,
  CHECK ((customer_key IS NULL) = (customer_started_at IS NULL))
);
CREATE TABLE pgstencil_billing.checkouts (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES pgstencil_billing.accounts(owner_id),
  plan text NOT NULL CHECK (plan IN ('monthly', 'yearly')),
  price_id text NOT NULL,
  trial_days integer NOT NULL CHECK (trial_days >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'open', 'complete', 'expired')),
  session_id text UNIQUE,
  url text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX billing_one_checkout ON pgstencil_billing.checkouts(owner_id) WHERE status IN ('pending', 'open');
CREATE TABLE pgstencil_billing.subscriptions (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES pgstencil_billing.accounts(owner_id),
  price_id text NOT NULL,
  status text NOT NULL,
  period_end timestamptz NOT NULL,
  trial_end timestamptz,
  cancel_at_period_end boolean NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX billing_subscription_owner ON pgstencil_billing.subscriptions(owner_id);
CREATE TABLE pgstencil_billing.events (
  id text PRIMARY KEY,
  type text NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  failed boolean NOT NULL DEFAULT false
);
-- Down Migration
DROP SCHEMA pgstencil_billing CASCADE;
