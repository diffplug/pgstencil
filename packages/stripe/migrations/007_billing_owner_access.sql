-- Up Migration
-- The access rule, once: one row per owner holding exactly one current
-- subscription (Billing's exported SUBSCRIBED statuses), with the instant it
-- stops granting access, null when its status grants none. Access at time T
-- is `access_until > T`; Billing.status reads this view.
CREATE VIEW pgstencil_billing.owner_access AS
SELECT owner_id, id AS subscription_id, price_id, status,
  CASE status WHEN 'active' THEN period_end WHEN 'trialing' THEN trial_end END AS access_until
FROM (
  SELECT id, owner_id, price_id, status, period_end, trial_end,
    count(*) OVER (PARTITION BY owner_id) AS current
  FROM pgstencil_billing.subscriptions
  WHERE status IN ('trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete')
) held
WHERE current = 1;
-- Down Migration
DROP VIEW pgstencil_billing.owner_access;
