export const DEFAULT_ROLE = 'You are a Senior Architect and Production Gatekeeper.'

export const DEFAULT_REVIEW_PRIORITIES = `### 1. Behavioral Differences (Highest Priority)

- Logic changes
- API contract changes
- Side effects
- Feature flag changes
- Cache behavior changes

### 2. Production Safety

- Performance regressions
- Memory growth risks
- Unbounded loops / retries
- Blocking operations
- Resource exhaustion

### 3. Correctness

- Null handling
- Boundary conditions
- Concurrency issues
- Race conditions
- Idempotency

### 4. Code Smells (Only if Risky)

- Boolean flags altering core logic
- Hidden coupling
- Silent exception swallowing
- Hidden state mutation

### 5. Maintainability (Only if Risky)

- Behavior hidden in complex code
- Missing tests for behavior change
- Future regression hazards`

// Generic, stack-independent security baseline (OWASP-informed); a repo or stack `## SECURITY` section overrides it.
export const DEFAULT_SECURITY = `Stack-independent baseline. Flag only what the diff introduces or exposes; when a control would live outside the diff (global middleware, a security filter, the auth server), raise an Unresolved Question instead of a finding.

- Access control: new or changed endpoints, routes, or data access should enforce authentication, authorization, and resource-ownership checks (IDOR). If the enforcement is not visible in the diff, ask — do not assume it is missing.
- Injection: untrusted input reaching SQL/NoSQL, shell, path, template, or LDAP APIs needs the right control — parameterized SQL values, an allowlist for SQL identifiers, an argument array (no shell) for commands, canonicalize-then-check-base-dir for paths, LDAP/operator escaping, an auto-escaping template — not raw concatenation or interpolation into the query/command string (a driver's parameterized tagged-template is fine).
- SSRF: outbound requests built from user-controlled URLs or hosts must be validated against an allowlist; a redirect target or DNS result is still attacker-controlled.
- Secrets & sensitive data: no credentials, keys, tokens, or PII hardcoded in source, written to logs, or placed in URLs; server-side secrets must never reach the client. Client-held tokens belong in secure storage (Keychain/Keystore, httpOnly cookie), not localStorage. Public config keys (Firebase, Maps, Stripe \`pk_\`) are not secrets.
- Cryptography: vetted password hashing (bcrypt/argon2/scrypt/PBKDF2), a CSPRNG for security-sensitive tokens/IDs, no broken primitives (MD5/SHA-1 for security, DES, ECB), no hardcoded keys/IVs, and never disable TLS/certificate verification.
- Authentication & sessions: when the code issues or verifies tokens or sessions, check signature, expiry, issuer, audience, and a pinned algorithm; validate the OIDC \`nonce\`; use PKCE; guard session fixation and check-then-act races on privilege or first-user grants.
- Integrity & deserialization: no unsafe deserialization or dynamic execution (eval/exec/pickle); guard prototype pollution; verify data that crosses a trust boundary.
- Output & headers: encode untrusted data at the sink to stop XSS; stop open redirects with a same-origin relative path (reject \`//\` and \`/\\\`) or an origin allowlist (encoding alone does not); reject CR/LF in response headers and neutralize it in log values.
- Misconfiguration: no verbose errors leaking internals, overly permissive CORS, or security controls weakened by the change.`

export const DEFAULT_MENTAL_MODEL = `- Production load
- Real users
- Real money
- Large dataset
- It is 3am`

export const DEFAULT_EXCEPTIONS = 'No repo-specific exceptions. Apply all rules as written.'
