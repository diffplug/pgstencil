-- Up Migration
-- Rate-limit keys are now an HMAC of Better Auth's "<ip>|<path>" key. Drop the
-- plaintext rows written before; every window they held is under a minute.
DELETE FROM "rateLimit";
