-- Up Migration
CREATE TABLE pgstencil_auth_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  started_at timestamptz NOT NULL
);

ALTER TABLE "session" ADD COLUMN "singleSession" boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX account_provider_identity ON "account" ("providerId", "accountId");

-- Serialize session creation per user, including across separate Workers.
-- A failed INSERT rolls back both the deletion and the lock.
CREATE FUNCTION pgstencil_session_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM "user" WHERE id = NEW."userId" FOR UPDATE;
  IF NEW."singleSession" THEN
    DELETE FROM "session" WHERE "userId" = NEW."userId";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pgstencil_session_policy BEFORE INSERT ON "session"
FOR EACH ROW EXECUTE FUNCTION pgstencil_session_policy();
