-- Up Migration
ALTER TABLE pgstencil_billing.checkouts DROP CONSTRAINT checkouts_plan_check;
ALTER TABLE pgstencil_billing.checkouts ADD CONSTRAINT checkouts_plan_check CHECK (plan ~ '^[A-Za-z0-9_-]{1,64}$');
ALTER TABLE pgstencil_billing.subscriptions ADD COLUMN started_at timestamptz, ADD COLUMN ended_at timestamptz;
CREATE INDEX billing_subscription_price ON pgstencil_billing.subscriptions(price_id);
-- Down Migration
DROP INDEX pgstencil_billing.billing_subscription_price;
ALTER TABLE pgstencil_billing.subscriptions DROP COLUMN ended_at, DROP COLUMN started_at;
ALTER TABLE pgstencil_billing.checkouts DROP CONSTRAINT checkouts_plan_check;
ALTER TABLE pgstencil_billing.checkouts ADD CONSTRAINT checkouts_plan_check CHECK (plan IN ('monthly', 'yearly'));
