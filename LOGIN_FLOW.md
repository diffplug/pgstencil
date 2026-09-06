# First example: email code and link login

Status: proposed example behavior and acceptance tests; not implemented yet. This example exercises pgstencil's database, HTTP, email, snapshot, time, and randomness infrastructure. Pages are server-rendered forms and work without client JavaScript.

## User flow

1. **Enter an email.** `/login` shows an email field and “Send sign-in code”. The example supports both new and returning users: create an account only after verifying mailbox access. A submitted address gets the same response shape regardless of whether an account already exists.
2. **Check email.** Show “Check your email” with one code input, “Verify code”, “Send a new code”, and “Use another email”. The input accepts an eight-digit code, including pasted spaces, and uses `autocomplete="one-time-code"` and a numeric input hint. Keep leading zeroes. State that the code expires in 10 minutes.
3. **Receive one email with two options.** Include the code (visually grouped, e.g. `1234 5678`), a “Sign in to pgstencil” link, the expiry time, and brief copy explaining that an unrequested email can be ignored. HTML and plaintext are both supplied by application templates and captured by EmailDev in tests.
4. **Enter the code or use the link.** Entering the code submits the form. Clicking the email link opens a “Confirm sign-in” page; its button submits the confirmation. Both paths verify the same login challenge, and successful use of either invalidates both.
5. **See the account page.** Redirect to `/account`, showing the verified email, sign-in time, session expiry, and a “Sign out” button. No notes CRUD is needed for the first example; the authentication flow supplies meaningful database queries and HTML snapshots.
6. **Expire or sign out.** The session lasts a fixed 24 hours without sliding renewal. Expiry redirects protected page requests to `/login` and clears the session cookie. Signing out revokes the database session immediately and clears the cookie.

The proposed 10-minute challenge, eight-digit code, five-attempt limit, and 24-hour session are configurable example defaults, not universal security requirements. This proves mailbox access; it is a single-factor login flow.

## Challenge and browser binding

Bind the challenge to a random, HttpOnly pending-login cookie in the browser that requested it. Both code verification and link confirmation require that binding. Use an independent CSRF token bound to the pending flow for form submissions, including initial login submission through an anonymous form context. Validate allowed request origins as additional protection.

The link works in the requesting browser. If opened on a different device/browser, display instructions to enter the emailed code in the original browser, or start a new login in this browser. Do not consume the challenge on a browser mismatch. This is a deliberate initial UX choice to prevent an emailed link from silently logging a different browser into an unintended account.

Give the code and link independent secrets under one challenge. Generate the code without modulo bias using the injected random-byte source; give the link a 32-byte random bearer token. A challenge identifier alone grants no access. Persist a keyed digest of the low-entropy code (with the key held outside the database), and a cryptographic hash of the high-entropy link token. Include challenge identity/purpose in the code digest. Use standard Node crypto primitives and constant-time digest comparison, not a custom cryptographic protocol.

These choices apply the general emailed-secret guidance on expiry, one-time use, secure generation/storage, and guessing limits from [OWASP's token/code guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## Requests and persistence

| Request | Behavior |
| --- | --- |
| `GET /login` | Render the email form and establish an anonymous form/CSRF context |
| `POST /login` | Validate form, check send limits, create a pending challenge and send/capture email; redirect to `/login/code` |
| `GET /login/code` | Render code entry for the pending flow |
| `POST /login/code` | Verify pending-browser binding, CSRF token, challenge, attempt budget and code; establish session on success |
| `POST /login/resend` | Rate-limit, replace this pending flow's challenge, invalidate its previous code/link, and send a new email |
| `GET /login/link?...` | Render confirmation only; never consume a token or create an authenticated session |
| `POST /login/link` | Verify browser binding, CSRF token, and link token; establish session on success |
| `GET /account` | Validate the session using server time and render account details, or redirect to login |
| `POST /logout` | Check CSRF, revoke the current session and clear the cookie |

Start with SQL migrations for `users`, `login_challenges`, `sessions`, and shared rate-limit state. Keep the pending-browser/CSRF context small and separate from authenticated sessions. Use Kysely for every application query. Apply the same documented email-normalization policy during lookup, uniqueness checks and rate limiting; do not invent provider-specific alias equivalence.

Challenge consumption and session creation happen in one database transaction. Lock or conditionally update the challenge while validating consumption, expiry and attempts; concurrent code/link requests must produce exactly one successful redemption. Only then create/find the verified user, create a fresh session, and return its cookie. Failure must not partially consume a challenge while leaving a usable session. Ensure failed-attempt counters commit on rejected verification, rather than rolling back with an exception.

Store session-token hashes with `user_id`, `created_at`, `expires_at`, and `revoked_at`; the cookie carries a fresh 32-byte opaque random token. Check validity on every authenticated request. Fresh authentication replaces the browser's prior session and pending state. Account creation races for the same email resolve through a unique database constraint.

## Request handling and abuse limits

Use the same login page/messages/status patterns for new and existing email addresses, and avoid account-dependent early exits or send behavior. Throttle sends by normalized email and source address, and verification by challenge, normalized email, and source address. Limits are shared in Postgres so multiple application instances cannot bypass them. Obtain the source address through explicitly configured proxy trust. [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) covers generic responses and login throttling.

Initial send policy: a 60-second resend cooldown, at most five sends per email per 15 minutes, and an independent configurable source-address ceiling. Allow at most five incorrect submissions per challenge, with additional email/source verification budgets that survive resend. Exceeding the challenge budget invalidates that challenge, not the user's account or existing sessions. All rate-limit windows and challenge deadlines use injected server time. Serialize competing resend/verification operations so replaced secrets cannot remain valid by racing an update.

Use a generic “That code is invalid or has expired” error with a way to request another. Email delivery failures leave no authenticated session; mark the undelivered challenge unusable and offer retry without revealing account existence. The first implementation directly awaits the injected sender; a durable mail queue is a separate requirement.

Build email links from a configured public origin and redirect only to fixed local destinations in this example. Keep secrets out of logs, redact link query parameters in access logging, disable caching on auth responses, set `Referrer-Policy: no-referrer`, and keep token-bearing pages free of third-party content. Successful verification redirects to a clean URL.

GET requests never authenticate or consume challenges. The confirmation POST protects against ordinary link-preview requests consuming the token: [Supabase documents email security scanners prefetching login links](https://supabase.com/docs/guides/auth/auth-email-templates#email-prefetching). Browser binding provides an additional check even if a scanner interacts with the form.

Production uses HTTPS with a host-only session cookie: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, and the `__Host-` prefix. Assert exact expiry and clearing attributes. Local HTTP uses explicitly configured development cookie settings and a different unprefixed name; test production cookie serialization separately. CSRF checks remain enabled. These follow [OWASP session-cookie guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Deterministic acceptance scenarios

Use a fresh IntegreSQL database, an application-local DevTime, a freshly seeded random source, an in-memory EmailDev, and Supertest clients. Fix test digest/configuration keys. Ordinary session tests use `agent()`; historical-time tests explicitly replay the captured cookie to verify server validation independently of client eviction.

| Scenario | Required evidence |
| --- | --- |
| New user enters code | User created only after verification; one session; email, challenge/user/session queries, cookie headers, page HTML and derived Markdown snapshots |
| Returning user enters code | Existing user reused; new session token; same outward login flow |
| Click link | Confirmation GET leaves challenge/session state unchanged; confirmation POST authenticates |
| Other browser opens link | Helpful fallback instructions; no consumption or session creation |
| Invalid code | Rejected, no session, failed-attempt count increases |
| Challenge expiry | Valid immediately before 10 minutes; invalid exactly at 10 minutes, for both code and link on separate fresh fixtures |
| Replay | After code success, neither code nor link can authenticate again; same after link success |
| Concurrent redemption | Parallel code/link submissions for the same challenge yield exactly one successful authentication |
| Resend | Previous code/link invalidated; new secret works; cooldown enforced; aggregate guessing budget persists |
| Throttling | Send and verification limits hold across multiple apps deliberately sharing a test database; advancing DevTime opens the next window |
| Session expiry | At Jan 1 2020, authenticate and capture the cookie; after 23 hours it works; after one more hour replay is rejected and the cookie is cleared |
| Logout | POST revokes session; replay cannot authenticate; missing/invalid CSRF rejected |
| Request forgery | Missing/wrong pending binding, invalid CSRF and untrusted origins cannot complete login |
| Secret handling | Persisted challenge/session rows contain digests, not plaintext secrets; production cookie flags and cache/referrer headers verified |
| Delivery failure | Failed sender produces no usable undelivered challenge or authenticated session; retry behavior clear |
| Parallel isolation | Twenty independent apps can use identical seeds and dates with identical snapshots and no shared mail, random state, sessions or database writes |

Use focused ordinary assertions for invariants and race outcomes; snapshots show readable state and responses. Keep email code/link contents visible in test artifacts because they come from deterministic test inputs. Snapshot security-relevant attributes rather than normalizing them away. Boundary tests compare against the injected time without sleeping or simulating timers.
