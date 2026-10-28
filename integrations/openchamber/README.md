# OpenChamber @-menu adapter

Source of truth for the adapter that adds Chrome tabs to the OpenChamber `@` menu. The modules are copied
verbatim from the installed OpenChamber 2.5.2 `resources/web-dist/octm/` directory; do not edit them here
without changing the installed build as well, otherwise the repo and the app drift apart.

- `runtime.mjs` – bootstraps the adapter into the running page: reads `__octmNative`, picks a client, installs
  `globalThis.__octm`, and reports readiness (`createAdapterRuntime`, `installAdapterRuntime`).
- `index.mjs` – `createChromeMentionAdapter(seams)`: the public `init, rows, count, select, isSendBlocked,
  closeMenu, cancel, invalidate, pair, state, subscribe, getSnapshot` surface.
- `draft-controller.mjs` – the state machine behind the adapter: one tab list per menu open, loading/pending/
  cancel/error rows, capture commit through the draft seams, and identity checks that drop stale results.
- `mention-source.mjs` – row factories, error copy, query parsing and the layout that appends Chrome rows after
  the native agents / open files / searched files / sessions rows.
- `bridge-client.mjs` – the HTTP client for the plugin's `/tab-context/v1/` bridge (`pair`, `list`, `capture`,
  `cancel`), plus the pairing dialog.
- `patch-manifest.mjs` – the pinned patch set that threads `__octm` into the minified asset, the seam contract
  and the patch application helpers.

## Seam contract

The patched asset publishes `globalThis.__octmNative` with synchronous handles:
`readComposer()` returning `{runtimeKey, directory, sessionId, draftId, sessionKey, generation, text, caret}`,
`addDraft(scope, payload)` returning a draft id or `null`, `editRange(from, to, insert)` and
`removeDraft(scope, id)`. The adapter is published as `globalThis.__octm` and exposes only the API above:
it never sends a message, it hands a captured page to the draft store and clears the mention range.
`patch-manifest.mjs` also exports the `SEAM_CONTRACT` that describes these handles field by field.

## Pinning

`PATCH_MANIFEST` records the version (`2.5.2`), the asset path, the pristine SHA-256
`4f288a1a01526447321b06f40adf7c2625252f570ecdd3afa1fee739ba860da6`, and ten patches with `order`, `action`
(`replace` / `insertAfter` / `insertBefore`), the exact marker, its single recorded offset and `occurrences: 1`.

Verify an install read-only:

```bash
node scripts/verify-openchamber-patch-manifest.mjs --syntax
node scripts/verify-openchamber-patch-manifest.mjs --asset <path> --syntax
```

The script refuses any asset whose SHA-256 differs from the pinned pristine value, so it reports `ok` only for
the audited build. An OpenChamber update replaces that asset: the hash and every offset stop matching, and the
manifest must be re-audited and re-pinned before the adapter can be trusted again. The installed app is never
written to; `--syntax` writes the patched module only to a throwaway temp directory.
