# OAuth login

The login example supports email, Google and Apple OpenID Connect, and Facebook and GitHub OAuth. Each configured provider adds a native **Continue with…** form to `/login`. Successful authentication creates the same fixed 24-hour application session as email login. Providers are disabled until configured; the normal test suite needs no credentials or provider network access.

## Local setup

```sh
cp .env.example .env
# Fill in credentials for the providers you want to enable.
pnpm dev
```

`pnpm dev` loads the optional `.env` using Node's built-in environment-file support. The example file selects `PORT=3000` and `PUBLIC_ORIGIN=http://127.0.0.1:3000`. Keep these consistent and register the exact callback URL, including hostname and port. `localhost` and `127.0.0.1` are different origins. With no credentials, email login and the local inbox continue to work normally.

| Provider | Environment variables                      | Local callback                                |
| -------- | ------------------------------------------ | --------------------------------------------- |
| Google   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `http://127.0.0.1:3000/oauth/google/callback` |
| GitHub   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `http://127.0.0.1:3000/oauth/github/callback` |

For Google, create a **Web application** OAuth client, configure the consent screen and any required test users, and add the callback under authorized redirect URIs. The application requests `openid email`; it does not request offline access or keep refresh tokens. See [Google's OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).

For GitHub, create an **OAuth App**, set its homepage to the public origin, and set its authorization callback URL to the GitHub callback above. The application requests `read:user user:email`, including permission to read a private verified email address. Use separate registrations for local and deployed environments. See [GitHub's OAuth web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) and [authenticated email API](https://docs.github.com/en/rest/users/emails).

For Apple, configure a web Services ID and register `https://your-app.example/oauth/apple/callback` as its return URL. Set `APPLE_CLIENT_ID` to that Services ID and `APPLE_CLIENT_SECRET` to an ES256 JWT signed with your Apple key (Team ID as issuer, Services ID as subject, `https://appleid.apple.com` as audience, key ID in the header). Apple client secrets expire; generate and replace them before their deadline (maximum six months). Apple's real web flow requires a registered HTTPS domain, not a localhost URL. Register your sending domain/address with Apple's private email relay when supporting Hide My Email. See [Apple client-secret setup](https://developer.apple.com/documentation/signinwithapplerestapi/creating-a-client-secret).

For Facebook, enable Facebook Login for your Meta app, request `email`, and register `https://your-app.example/oauth/facebook/callback`. Set `FACEBOOK_CLIENT_ID` and `FACEBOOK_CLIENT_SECRET`. Review the app's configured Graph API version; our endpoints use that app version. App development mode restricts login to permitted test accounts/roles. Facebook's authenticated primary email is trusted, matching [Supabase's Facebook provider](https://github.com/supabase/auth/blob/master/internal/api/provider/facebook.go); an absent email or declined permission fails closed. We do not interpret a profile's `verified` field as email verification. No matching-email account merging occurs.

Both credentials are required for each enabled provider. `.env` files are ignored by Git; `.env.example` contains no credentials. A configured development server also requires `PUBLIC_ORIGIN`. Configuration errors fail startup without printing secrets.

## Accounts and linking

A provider identity is `(provider, subject)`: the OIDC `sub` or the provider's stable user ID. Usernames and email addresses are not identity keys. A changed provider email continues to sign into the same linked account and does not silently change its local recovery email.

A new, verified provider email creates an account. If the email already belongs to a local account, sign-in stops with instructions to use an existing method, then connect the provider from `/account`. Matching emails never automatically merge accounts.

Connecting requires a valid session created within the last five minutes, a session-bound CSRF token, and the provider verifying the same email as the local account. The same session must remain valid through the callback. Connecting rotates the session and revokes its predecessor. A provider identity cannot move between accounts, and an account cannot replace an already connected identity from the same provider. Unlinking and account merging are outside this example.

Email sign-in remains available for the account's stored address, so account security also depends on control of that mailbox. Provider login does not make this an MFA flow.

## Protocol and storage

[`openid-client`](https://github.com/panva/openid-client) owns code exchange and protocol validation. Google uses discovery and signed ID tokens, with signature, issuer, audience, expiry, nonce, state, and PKCE validation. GitHub uses fixed OAuth endpoints, PKCE S256, and authenticated `/user` and `/user/emails` requests; the public profile email is ignored. Its verified primary email can be private or on a later page.

Apple validates signed ID tokens, issuer, audience, expiry and nonce, accepting the provider's boolean or string `email_verified` claim. It does not advertise PKCE. Its cross-site `form_post` callback is relayed with 303 to the same callback's GET so the browser sends its original SameSite=Lax binding cookie. The POST neither consumes state nor creates a session, and callback responses use `no-store` / `no-referrer`. Only state, code and error survive the relay; unsigned user data is ignored. Facebook uses state plus the same independent browser cookie, server-side code exchange and an authenticated `/me` request with HMAC `appsecret_proof`; it does not claim PKCE support.

An Apple private relay address may differ from an existing account's address. Under the current same-email linking policy, use a matching address to connect, or sign up with Apple first and use that stored relay address for email login. Account merging is not implemented.

Starting or connecting is a same-origin POST with CSRF protection. Each attempt has independent random state and a browser-binding HttpOnly/SameSite=Lax cookie. The database stores their hashes; purpose-separated HMAC derivation supplies the PKCE verifier and OIDC nonce from state and the application secret. Servers sharing the database, public origin, credentials, and secret can finish each other's attempts.

Attempts expire after ten minutes, or sooner when a connecting session reaches five minutes of age. A callback atomically consumes the attempt before contacting the provider. Cancellation, exchange failure, or replay requires a new attempt. Missing or mismatched state, browser cookie, provider, or callback origin fails before exchange. Deadlines and connecting sessions are checked again after network I/O. Starting another attempt in the same browser replaces its binding cookie, so the latest attempt is the usable one.

Application session tokens remain opaque, hashed in Postgres, and fixed at 24 hours. Access, refresh, and ID tokens are used only during the callback and never persisted or rendered. Provider error descriptions are not reflected into pages. The example limits OAuth starts to 30 per direct peer IP per 15-minute application-time window; see the proxy limitation below.

`002_oauth.sql` adds identities and attempts without changing existing email accounts or sessions. The migration upgrade test proves existing data survives. Expired/consumed attempt retention is not automated; any production cleanup must remove old OAuth attempts before referenced sessions.

## Tests without real secrets

```sh
pnpm test tests/integration/oauth-providers.test.ts tests/integration/oauth.test.ts
pnpm snapshot:update tests/integration/oauth.test.ts
pnpm check
pnpm db:verify
```

The test provider is a local HTTP server with dummy clients, real RSA-signed JWTs, discovery/JWKS, one-use authorization codes, PKCE verification, and GitHub profile/email endpoints. An injected transport maps only the known provider URLs to this server and rejects unknown network destinations. No test contacts a real OAuth provider. The fixture also serves Apple discovery/JWKS and Facebook profile endpoints. [Workers tests](tests/integration/workers.test.ts) exercise all three target providers in workerd with real Postgres.

Coverage includes invalid signatures/claims/nonces, missing or unverified email, PKCE mismatch, paginated private email, cancellation, forged callbacks, exact expiry boundaries, expiry during exchange, replay and concurrent redemption, provider outages, rate limits, session rotation/logout, linking conflicts and freshness, disabled configuration, HTTPS cookie attributes, and callbacks reaching a second application instance. Real Postgres backs every application scenario.

[OAuth snapshots](tests/integration/snapshots/oauth) cover query results, cookies and redirect headers, full HTML, and derived Markdown. Application state, nonce derivation, cookies, and timestamps use injected randomness/time. The upstream JWT protocol uses wall time, just like a real external provider; its keys/tokens are not snapshot inputs. Only the fixture's known origin, including its URL-encoded representation inside `redirect_uri`, is normalized.

These tests cannot verify registered callback URLs, real consent screens, provider account restrictions, or deployed browser/TLS/proxy behavior. With real credentials, manually complete each provider's login, cancellation, existing-account connection, and logout using your registered origin before deployment.

## Production composition

```ts
import { startProduction } from './examples/login/src/production.ts';
import { oauthFromEnvironment } from './examples/login/src/oauth-providers.ts';

await startProduction({
  databaseUrl,
  publicOrigin: 'https://your-app.example',
  secret: sharedHighEntropySecret,
  email: yourEmailSender,
  oauth: oauthFromEnvironment(process.env),
  port: 3000,
});
```

Register `https://your-app.example/oauth/google/callback` and `https://your-app.example/oauth/github/callback` with their respective providers. Apply migrations before starting the deployment. `startProduction` uses real time, secure randomness, HTTPS origin validation, Secure `__Host-` cookies, and no inbox routes. The transport seam is available only on the lower-level application factory, not the production wrapper.

Use a same-host HTTPS reverse proxy and keep the public origin fixed; request Host/forwarded headers never choose callback destinations. The example sees the proxy's IP, so configure internet-facing rate limits at the trusted proxy rather than forwarding untrusted client IP headers. Exclude token-bearing callback/link query strings from access logs. Rotating the shared application secret invalidates in-flight OAuth proofs and existing CSRF derivations; coordinate it across instances.

For Hono, Fetch handlers, or Cloudflare Workers, see [WORKERS.md](WORKERS.md).
