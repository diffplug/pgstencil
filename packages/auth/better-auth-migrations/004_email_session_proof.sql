-- Up Migration
-- Only sessions created by a successful email OTP can prove current mailbox ownership.
-- Existing sessions must verify again before supplying this proof.
alter table "session" add column "emailAuthenticated" boolean not null default false;
