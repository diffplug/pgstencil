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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: pgstencil_billing; Owner: -
--

CREATE TABLE pgstencil_billing.accounts (
    owner_id text NOT NULL,
    email text NOT NULL,
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
    CONSTRAINT checkouts_plan_check CHECK ((plan = ANY (ARRAY['monthly'::text, 'yearly'::text]))),
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
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: login_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_challenges (
    id text NOT NULL,
    flow_id text NOT NULL,
    email text NOT NULL,
    code_digest text NOT NULL,
    link_hash text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    invalidated_at timestamp with time zone,
    delivered_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT login_challenges_attempts_check CHECK ((attempts >= 0))
);


--
-- Name: login_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_flows (
    id text NOT NULL,
    binding_hash text NOT NULL,
    csrf_hash text NOT NULL,
    email text,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: oauth_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_flows (
    state_hash text NOT NULL,
    provider text NOT NULL,
    browser_hash text NOT NULL,
    redirect_uri text NOT NULL,
    link_user_id text,
    link_session_hash text,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT oauth_flows_check CHECK (((link_user_id IS NULL) = (link_session_hash IS NULL))),
    CONSTRAINT oauth_flows_provider_check CHECK ((provider = ANY (ARRAY['google'::text, 'github'::text])))
);


--
-- Name: oauth_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_identities (
    provider text NOT NULL,
    subject text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT oauth_identities_provider_check CHECK ((provider = ANY (ARRAY['google'::text, 'github'::text])))
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
-- Name: pgstencil_migration_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgstencil_migration_files (
    name text NOT NULL,
    hash text NOT NULL
);


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limits (
    key text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    count integer NOT NULL,
    CONSTRAINT rate_limits_count_check CHECK ((count >= 0))
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    token_hash text NOT NULL,
    user_id text NOT NULL,
    csrf_hash text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone NOT NULL
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
-- Name: login_challenges login_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_challenges
    ADD CONSTRAINT login_challenges_pkey PRIMARY KEY (id);


--
-- Name: login_flows login_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_flows
    ADD CONSTRAINT login_flows_pkey PRIMARY KEY (id);


--
-- Name: oauth_flows oauth_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_flows
    ADD CONSTRAINT oauth_flows_pkey PRIMARY KEY (state_hash);


--
-- Name: oauth_identities oauth_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_identities
    ADD CONSTRAINT oauth_identities_pkey PRIMARY KEY (provider, subject);


--
-- Name: oauth_identities oauth_identities_user_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_identities
    ADD CONSTRAINT oauth_identities_user_id_provider_key UNIQUE (user_id, provider);


--
-- Name: pgmigrations pgmigrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations
    ADD CONSTRAINT pgmigrations_pkey PRIMARY KEY (id);


--
-- Name: pgstencil_migration_files pgstencil_migration_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgstencil_migration_files
    ADD CONSTRAINT pgstencil_migration_files_pkey PRIMARY KEY (name);


--
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: billing_one_checkout; Type: INDEX; Schema: pgstencil_billing; Owner: -
--

CREATE UNIQUE INDEX billing_one_checkout ON pgstencil_billing.checkouts USING btree (owner_id) WHERE (status = ANY (ARRAY['pending'::text, 'open'::text]));


--
-- Name: billing_subscription_owner; Type: INDEX; Schema: pgstencil_billing; Owner: -
--

CREATE INDEX billing_subscription_owner ON pgstencil_billing.subscriptions USING btree (owner_id);


--
-- Name: login_challenges_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_challenges_flow ON public.login_challenges USING btree (flow_id, created_at);


--
-- Name: oauth_flows_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_flows_expiry ON public.oauth_flows USING btree (expires_at);


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
-- Name: login_challenges login_challenges_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_challenges
    ADD CONSTRAINT login_challenges_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.login_flows(id) ON DELETE CASCADE;


--
-- Name: oauth_flows oauth_flows_link_session_hash_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_flows
    ADD CONSTRAINT oauth_flows_link_session_hash_fkey FOREIGN KEY (link_session_hash) REFERENCES public.sessions(token_hash);


--
-- Name: oauth_flows oauth_flows_link_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_flows
    ADD CONSTRAINT oauth_flows_link_user_id_fkey FOREIGN KEY (link_user_id) REFERENCES public.users(id);


--
-- Name: oauth_identities oauth_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_identities
    ADD CONSTRAINT oauth_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict pgstencil

