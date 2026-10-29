-- Up Migration
ALTER TABLE pgstencil_billing.subscriptions ADD COLUMN end_reason text CHECK (end_reason ~ '^[a-z0-9:-]{1,40}$');
-- Down Migration
ALTER TABLE pgstencil_billing.subscriptions DROP COLUMN end_reason;
