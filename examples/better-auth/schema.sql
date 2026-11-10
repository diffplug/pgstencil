--
-- PostgreSQL database dump
--

\restrict pgstencil


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgstencil_billing; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA pgstencil_billing;


--
-- Name: pgstencil_session_policy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pgstencil_session_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM id FROM "user" WHERE id = NEW."userId" FOR UPDATE;
  IF NEW."singleSession" THEN
    DELETE FROM "session" WHERE "userId" = NEW."userId";
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: pgstencil_billing; Owner: -
--

CREATE TABLE pgstencil_billing.accounts (
    owner_id text NOT NULL,
    email text,
    created_at timestamp with time zone NOT NULL,
    trial_used_at timestamp with time zone,
    customer_id text,
    customer_key text,
    customer_started_at timestamp with time zone,
    CONSTRAINT accounts_check CHECK (((customer_key IS NULL) = (customer_started_at IS NULL)))
);


--
-- Name: checkouts; Type: TABLE; Schema: pgstencil_billing; Owner: -
--

CREATE TABLE pgstencil_billing.checkouts (
    id text NOT NULL,
    owner_id text NOT NULL,
    plan text NOT NULL,
    price_id text NOT NULL,
    trial_days integer NOT NULL,
    status text NOT NULL,
    session_id text,
    url text,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ref text,
    CONSTRAINT checkouts_plan_check CHECK ((plan ~ '^[A-Za-z0-9_-]{1,64}$'::text)),
    CONSTRAINT checkouts_ref_check CHECK ((ref ~ '^[a-z0-9:-]{1,40}$'::text)),
    CONSTRAINT checkouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'open'::text, 'complete'::text, 'expired'::text]))),
    CONSTRAINT checkouts_trial_days_check CHECK ((trial_days >= 0))
);


--
-- Name: events; Type: TABLE; Schema: pgstencil_billing; Owner: -
--

CREATE TABLE pgstencil_billing.events (
    id text NOT NULL,
    type text NOT NULL,
    received_at timestamp with time zone NOT NULL,
    processed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    failed boolean DEFAULT false NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: pgstencil_billing; Owner: -
--

CREATE TABLE pgstencil_billing.subscriptions (
    id text NOT NULL,
    owner_id text NOT NULL,
    price_id text NOT NULL,
    status text NOT NULL,
    period_end timestamp with time zone NOT NULL,
    trial_end timestamp with time zone,
    cancel_at_period_end boolean NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    end_reason text,
    CONSTRAINT subscriptions_end_reason_check CHECK ((end_reason ~ '^[a-z0-9:-]{1,40}$'::text))
);


--
-- Name: owner_access; Type: VIEW; Schema: pgstencil_billing; Owner: -
--

CREATE VIEW pgstencil_billing.owner_access AS
 SELECT owner_id,
    id AS subscription_id,
    price_id,
    status,
        CASE status
            WHEN 'active'::text THEN period_end
            WHEN 'trialing'::text THEN trial_end
            ELSE NULL::timestamp with time zone
        END AS access_until
   FROM ( SELECT subscriptions.id,
            subscriptions.owner_id,
            subscriptions.price_id,
            subscriptions.status,
            subscriptions.period_end,
            subscriptions.trial_end,
            count(*) OVER (PARTITION BY subscriptions.owner_id) AS current
           FROM pgstencil_billing.subscriptions
          WHERE (subscriptions.status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'unpaid'::text, 'paused'::text, 'incomplete'::text]))) held
  WHERE (current = 1);


--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: pgmigrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgmigrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    run_on timestamp without time zone NOT NULL
);


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pgmigrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pgmigrations_id_seq OWNED BY public.pgmigrations.id;


--
-- Name: pgstencil_auth_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgstencil_auth_limits (
    key text NOT NULL,
    count integer NOT NULL,
    started_at timestamp with time zone NOT NULL
);


--
-- Name: pgstencil_migration_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgstencil_migration_files (
    name text NOT NULL,
    hash text NOT NULL
);


--
-- Name: pgstencil_oauth_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgstencil_oauth_claims (
    key text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: rateLimit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."rateLimit" (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    "lastRequest" bigint NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    "singleSession" boolean DEFAULT false NOT NULL,
    "emailAuthenticated" boolean DEFAULT false NOT NULL
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: pgmigrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations ALTER COLUMN id SET DEFAULT nextval('public.pgmigrations_id_seq'::regclass);


--
-- Name: accounts accounts_customer_id_key; Type: CONSTRAINT; Schema: pgstencil_billing; Owner: -
--

ALTER TABLE ONLY pgstencil_billing.accounts
    ADD CONSTRAINT accounts_customer_id_key UNIQUE (customer_id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: pgstencil_billing; Owner: -
--

ALTER TABLE ONLY pgstencil_billing.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (owner_id);


--
-- Name: checkouts checkouts_pkey; Type: CONSTRAINT; Schema: pgstencil_billing; Owner: -
--

ALTER TABLE ONLY pgstencil_billing.checkouts
    ADD CONSTRAINT checkouts_pkey PRIMARY KEY (id);


--
-- Name: checkouts checkouts_session_id_key; Type: CONSTRAINT; Schema: pgstencil_billing; Owner: -
--

ALTER TABLE ONLY pgstencil_billing.checkouts
    ADD CONSTRAINT checkouts_session_id_key UNIQUE (session_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: pgstencil_billing; Owner: -
--

ALTER TABLE ONLY pgstencil_billing.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: pgstencil_billing; Owner: -
--

ALTER TABLE ONLY pgstencil_billing.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: pgmigrations pgmigrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations
    ADD CONSTRAINT pgmigrations_pkey PRIMARY KEY (id);


--
-- Name: pgstencil_auth_limits pgstencil_auth_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgstencil_auth_limits
    ADD CONSTRAINT pgstencil_auth_limits_pkey PRIMARY KEY (key);


--
-- Name: pgstencil_migration_files pgstencil_migration_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgstencil_migration_files
    ADD CONSTRAINT pgstencil_migration_files_pkey PRIMARY KEY (name);


--
-- Name: pgstencil_oauth_claims pgstencil_oauth_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgstencil_oauth_claims
    ADD CONSTRAINT pgstencil_oauth_claims_pkey PRIMARY KEY (key);


--
-- Name: rateLimit rateLimit_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."rateLimit"
    ADD CONSTRAINT "rateLimit_key_key" UNIQUE (key);


--
-- Name: rateLimit rateLimit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."rateLimit"
    ADD CONSTRAINT "rateLimit_pkey" PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: billing_one_checkout; Type: INDEX; Schema: pgstencil_billing; Owner: -
--

CREATE UNIQUE INDEX billing_one_checkout ON pgstencil_billing.checkouts USING btree (owner_id) WHERE (status = ANY (ARRAY['pending'::text, 'open'::text]));


--
-- Name: billing_subscription_owner; Type: INDEX; Schema: pgstencil_billing; Owner: -
--

CREATE INDEX billing_subscription_owner ON pgstencil_billing.subscriptions USING btree (owner_id);


--
-- Name: billing_subscription_price; Type: INDEX; Schema: pgstencil_billing; Owner: -
--

CREATE INDEX billing_subscription_price ON pgstencil_billing.subscriptions USING btree (price_id);


--
-- Name: account_provider_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_provider_identity ON public.account USING btree ("providerId", "accountId");


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");


--
-- Name: pgstencil_auth_limit_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pgstencil_auth_limit_expiry ON public.pgstencil_auth_limits USING btree (started_at);


--
-- Name: pgstencil_oauth_claim_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pgstencil_oauth_claim_expiry ON public.pgstencil_oauth_claims USING btree (expires_at);


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: session pgstencil_session_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pgstencil_session_policy BEFORE INSERT ON public.session FOR EACH ROW EXECUTE FUNCTION public.pgstencil_session_policy();


--
-- Name: checkouts checkouts_owner_id_fkey; Type: FK CONSTRAINT; Schema: pgstencil_billing; Owner: -
--

ALTER TABLE ONLY pgstencil_billing.checkouts
    ADD CONSTRAINT checkouts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES pgstencil_billing.accounts(owner_id);


--
-- Name: subscriptions subscriptions_owner_id_fkey; Type: FK CONSTRAINT; Schema: pgstencil_billing; Owner: -
--

ALTER TABLE ONLY pgstencil_billing.subscriptions
    ADD CONSTRAINT subscriptions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES pgstencil_billing.accounts(owner_id);


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict pgstencil

