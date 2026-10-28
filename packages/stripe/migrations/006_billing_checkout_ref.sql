-- Up Migration
ALTER TABLE pgstencil_billing.checkouts ADD COLUMN ref text CHECK (ref ~ '^[a-z0-9:-]{1,40}$');
-- Down Migration
ALTER TABLE pgstencil_billing.checkouts DROP COLUMN ref;
