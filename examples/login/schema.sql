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

SET default_tablespace = '';

SET default_table_access_method = heap;

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
-- Name: login_challenges_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_challenges_flow ON public.login_challenges USING btree (flow_id, created_at);


--
-- Name: oauth_flows_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_flows_expiry ON public.oauth_flows USING btree (expires_at);


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

