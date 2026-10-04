-- Up Migration
ALTER TABLE pgstencil_billing.accounts ALTER COLUMN email DROP NOT NULL;
-- Down Migration
ALTER TABLE pgstencil_billing.accounts ALTER COLUMN email SET NOT NULL;
