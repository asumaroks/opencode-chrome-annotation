# Tab context protocol v1

Status: implemented and authoritative. This is the wire contract between the Chrome extension, the
OpenChamber adapter and the plugin bridge, implemented in `src/tab-context.ts`,
`extension-src/tab-context.ts` and `integrations/openchamber/bridge-client.mjs`. Where this document
and the code disagree, the code wins.

## Transport

- `POST http://127.0.0.1:<39240-39260>/tab-context/v1/<route>`. The plugin binds only `127.0.0.1`
  and walks the bounded port range until one port accepts. A request URL that differs from its path
  (any query string) is `400 query-forbidden`.
- JSON only. `content-type` must be `application/json` (parameters such as `charset` are ignored);
  anything else is `415 json-required`. An unparseable body is `400 invalid-json`.
- Bodies are read with a 5000 ms deadline and a 131072-byte cap: `408 body-timeout`,
  `413 packet-too-large`. A failed or aborted read is `400 body-failed` / `400 body-aborted`.
- Every response is JSON and carries the envelope `{"version": 1, "instanceId": "<bridge id>"}` plus
  route fields. Responses also send `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Access-Control-Allow-Origin` echoing the request origin, and `Vary: Origin`.
- Every request body must also carry `version: 1` and the same `instanceId`; a mismatch is
  `409 instance-mismatch`, so a stale tab cannot talk to a restarted plugin.

## Roles and routes

Two roles share one connection object. The extension role owns `begin`, `poll` and `reply`; the
adapter role owns `pair`, `request`, `result` and `cancel`. Sending an extension route from an
adapter origin, or the reverse, is `403 wrong-role`. Paths outside `/tab-context/` are not handled by
the bridge and fall through to the legacy annotation routes; anything under `/tab-context/` that is
not a known v1 route is `404 unknown-route`.

| Role | Route | Request fields | Success | Errors |
| --- | --- | --- | --- | --- |
| extension | `begin` | none | `201 {connectionId, capability, code, expiresAt}`; `code` is 8 digits, `expiresAt` is +60 s | `429 connection-limit` at 8 live connections |
| extension | `poll` | `connectionId` | `200 {connectionId, expiresAt, cancelled[], jobs[]}`; at most one job per poll, each job repeats `version`, `instanceId` and `limits` | `409 pairing-required` while no adapter has paired (the extension client reads this as "not paired yet") |
| extension | `reply` | `connectionId`, `requestId`, `draft`, `status`, `result` or `error` | `200 {ok: true}` | `410 request-not-pending`, `409 draft-mismatch`, `400 invalid-status`, `400 invalid-error`, `400 capture-mismatch`, `400 invalid-tabs`, `400 duplicate-tab`, `400 invalid-capture` |
| adapter | `pair` | `code` | `201 {connectionId, capability, expiresAt}`; capability lives 300 s | `403 invalid-code`, `429 pairing-rate-limit` |
| adapter | `request` | `connectionId`, `kind` (`list` or `capture`), `draft`, `target` for capture | `202 {requestId, connectionId, expiresAt, limits}` | `409 pairing-required`, `409 project-mismatch`, `429 request-limit` at 32 live jobs, `400 invalid-kind`, `400 invalid-field` |
| adapter | `result` | `connectionId`, `requestId` | `202 {requestId, expiresAt, status: "pending"}` or `200 {requestId, connectionId, draft, status, result}` / `200 {…, status: "error", error}` | `410 request-expired-or-consumed` once the reply was consumed or the job expired |
| adapter | `cancel` | `connectionId`, `requestId` | `200 {ok: true}`; a job that was already delivered surfaces in the next `poll` as a cancelled `requestId` (32 buffered) | `410 request-expired-or-consumed` |

`poll` returns only jobs for the calling connection that were not delivered yet, and marks them
delivered, so `reply` only accepts a delivered job without a response. `result` returns a reply
exactly once and deletes the job.

## Envelope, headers and capabilities

- The capability is sent in the `x-tab-context-capability` header, never in a URL, path, body or
  query string; there is no query-string route at all.
- The launcher declaration is sent in the `x-tab-context-launcher` header, also never in a URL, path
  or body. It carries only the adapter origin, never a capability.
- Capabilities are 32 random bytes as base64url, minted per connection: one for the extension
  identity, a second for the adapter after pairing. Routes other than `begin` and `pair` require
  exactly one connection matching both origin and capability; anything else is `401 unauthorized`.
- The header is compared with `timingSafeEqual` after a length check, so a wrong length and a wrong
  value cost the same work.
- Preflight is narrow: `OPTIONS` must ask for `POST` and only for `content-type`,
  `x-tab-context-capability` and `x-tab-context-launcher`. Any other method is `405 post-required`,
  any other requested header is `403 untrusted-header`, and an allowed preflight returns
  `200 {ok: true}` with `Access-Control-Allow-Methods: POST` and the three allowed headers.

## Trust

- `Host` must equal `127.0.0.1:<the port the socket is actually bound to>` and the remote address
  must be `127.0.0.1` or `::ffff:127.0.0.1`; otherwise `403 untrusted-host`. This blocks DNS
  rebinding and any non-loopback peer.
- `Origin` is required and is checked twice: once against the combined allowlist and again against
  the role's own allowlist. A missing, `null` or unrecognised origin is `403 untrusted-origin`.
- One documented exception exists for the custom-scheme launcher, whose page has no script-readable
  origin. On the adapter routes (`pair`, `request`, `result`, `cancel`) only, a request with no
  `Origin` header or `Origin: null` may carry `x-tab-context-launcher: <origin>`, the origin its
  build was packaged with. The declaration is honoured only when that exact string is already an
  entry of the configured adapter allowlist, and it is then used as the request origin for the role
  check and for the connection binding. The header is never trusted for an extension route, never
  overrides a real `Origin`, and does not replace authorization: an adapter still needs the 8-digit
  one-time pairing code and the per-connection capability, so `Origin: null` from any other client
  is still `403 untrusted-origin`.
- Adapter origins come from `OPENCODE_TAB_CONTEXT_ADAPTER_ORIGINS` (comma separated) when set,
  otherwise from the JSON file at `OPENCODE_TAB_CONTEXT_CONFIG` (default
  `<package-root>/tab-context.json`), key `adapterOrigins`.
- Extension origins follow the same order with `OPENCODE_TAB_CONTEXT_EXTENSION_ORIGINS` and the
  `extensionOrigins` key.
- The OpenChamber launcher origin `openchamber-ui://app` is a valid adapter origin. Any other
  adapter origin must be an exact `http`/`https` loopback origin (`127.0.0.1`, `localhost` or
  `[::1]`) with no credentials, path, query or fragment. Nothing is trusted implicitly: an adapter
  origin absent from the allowlist is refused before pairing is even considered.
- For the extension role, any well-formed `chrome-extension://<32 a-p characters>` origin is
  accepted, and so is every configured `extensionOrigins` entry of that shape. An unpacked
  extension's id does not exist before install, so it cannot be pinned in advance; the 8-digit
  pairing code is the consent step that binds one extension instance to one adapter.
## Pairing

1. The extension calls `begin` from its own origin and receives `{connectionId, capability, code,
   expiresAt}`. The connection is unpaired and expires after 60 s unless pairing completes.
2. The user copies the 8-digit `code` into the pairing dialog that the **Connect Chrome…** row of the
   `@` menu opens. The dialog names the adapter origin that must already be trusted, edits the code in a
   numeric 8-digit input, submits on the Pair button or on `Enter` (ignored while an IME composition is
   active), calls `pair` from the adapter origin and shows fixed failure text in place while staying open.
   A successful `pair` consumes the code (a second attempt gets `403 invalid-code`), records the adapter
   origin, mints a second capability and extends the connection to 300 s.
3. Pairing attempts are limited to 5 per rolling 60 s window, shared by every origin
   (`429 pairing-rate-limit`).
4. Either side may drop the connection at any time; `close()` clears all connections and jobs, and a
   1 s sweep removes expired connections, jobs and cancellations.

## Limits

| Limit | Value |
| --- | --- |
| Request body and reply packet | 131 072 bytes |
| Capture text | 24 000 characters |
| Tab list | 100 tabs |
| Tab title | 2 048 characters |
| Tab URL | 8 192 characters, `http`/`https` only, no credentials |
| Opaque ids (`tabRef`, `documentId`, `draftId`, `requestId`, …) | 512 characters |
| Draft `directory` | 4 096 characters |
| Request TTL | 15 000 ms, capped by the connection expiry |
| Unpaired connection TTL | 60 000 ms |
| Paired connection TTL | 300 000 ms |
| Live connections | 8 |
| Live jobs | 32 |
| Buffered cancellations | 32 |
| State | memory only; restart or `close()` discards everything |

## Draft identity

Every `request` carries a draft identity:

```json
{"runtimeKey": "…", "directory": "…", "sessionId": "…", "draftId": "…", "generation": 3}
```

`directory` must equal the plugin's project directory (`409 project-mismatch` otherwise).
`sessionId` may be `null`; `generation` must be a non-negative safe integer (`400
invalid-generation`).

The bridge stores that object and returns it in the job payload and in `result`. A `reply` must echo
it byte-identically: the bridge compares `JSON.stringify` of the submitted draft with the stored one,
so field order and value types matter, and any difference is `409 draft-mismatch`. The adapter relies
on this to drop a capture for a composer state the user has already left.

For capture the reply must also echo `tabRef`, `url` and `documentId` exactly as issued
(`400 capture-mismatch` otherwise) and may contain only
`tabRef, url, documentId, title, text, capturedAt, truncated`. For a list reply, `tabRef` values must
be unique and every URL must be an `http`/`https` URL without credentials.

## Errors

The server error string is stable; clients map it to a fixed user-facing code before showing copy.

| Server code | HTTP | Client code |
| --- | --- | --- |
| `untrusted-origin`, `untrusted-host`, `untrusted-header`, `wrong-role` | 403 | `untrusted-origin` |
| `unauthorized` | 401 | `unauthorized` |
| `pairing-required` | 409 | `pairing-required` |
| `invalid-code` | 403 | `pairing-failed` |
| `pairing-rate-limit`, `connection-limit`, `request-limit` | 429 | `rate-limited` |
| `project-mismatch`, `draft-mismatch` | 409 | `draft-rejected` |
| `request-expired-or-consumed`, `request-not-pending` | 410 | `request-expired` |
| `instance-mismatch`, `bridge-closed` | 409 / 503 | `unavailable` |
| `body-timeout` | 408 | `timeout` |
| `invalid-payload`, `invalid-field`, `invalid-url`, `invalid-json`, `json-required`, `packet-too-large`, `query-forbidden`, `post-required`, `unknown-route` | 400–415 | `invalid-response` |

The six capture errors travel unchanged from the extension to the adapter:
`permission-denied`, `tab-closed`, `navigation-changed`, `empty-text`, `unavailable`,
`capture-failed`. Any other value in a reply is `400 invalid-error`.

## What is never sent

- No cookies, no site storage, no form values: `input`, `textarea`, `select`, `option`, `script`,
  `style`, `noscript`, `template`, `iframe`, `object` and `embed` content is skipped.
- No screenshots and no incognito tabs; capture happens only for a tab the user selected explicitly,
  and only for its main document (`frameId: 0`, active document), after the URL, document id and
  navigation revision still match the issued target.
- Page text is untrusted data. It is stored as a draft attachment with the title, URL and capture
  time in front of it, never executed and never treated as instructions.
