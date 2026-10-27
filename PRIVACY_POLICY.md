# Privacy Policy for OpenCode Chrome Annotation

Submitted for Chrome Web Store review — updated: 2026-10-27

This policy describes the independent, modified distribution of OpenCode Chrome Annotation maintained in [asumaroks/opencode-chrome-annotation](https://github.com/asumaroks/opencode-chrome-annotation). It is based on the upstream project by Benjamin Shafii; original authorship and copyright notices are retained under [GPL-3.0-only](LICENSE). It does not describe the upstream Chrome Web Store listing.

The disclosures below describe the reviewed implementation, not a legal compliance guarantee or confirmation of Chrome Web Store approval. A separate store listing for this distribution has been created and submitted for Chrome Web Store review; it is not public until that review is approved.

## What this extension does

When you use the extension, it can capture and send annotation context that you explicitly trigger:
- Your annotation text/comment
- Selected element metadata: selector, tag, text, role, aria label, and bounds
- Current page URL and title
- Viewport dimensions and device pixel ratio
- A PNG screenshot of the visible tab, which can include content outside the selected element
- Routing information: tab ID, selected OpenCode session ID, and extension version

Page content, URLs, element text, and screenshots can contain personal or confidential information. Check what is visible before submitting an annotation.

## How data is used

Annotation context is used to deliver your request to your selected OpenCode session. Connection state and diagnostic information support routing and troubleshooting.

1. The extension sends the annotation payload over HTTP to the selected local plugin instance at `127.0.0.1` on a port in the range `39240-39260`, using its `/annotation` API.
2. The plugin decodes the screenshot into a local file and builds a prompt containing your comment, page and element metadata, viewport information, and tab ID.
3. The plugin calls OpenCode's `context.session.prompt` with that text and a screenshot file attachment.
4. OpenCode processes the prompt and attachment through the model provider configured by the user. Depending on that configuration, annotation text and screenshot content may be sent to a remote provider.

The extension-to-plugin connection is local; the complete workflow is not necessarily local-only. OpenCode and provider transport, storage, retention, and other handling are outside this extension's implementation and depend on the user's configuration and the applicable provider policies.

## Data sharing and sale

- No extension-operated remote annotation upload backend, telemetry backend, or third-party tracking SDK was found in the reviewed implementation.
- No sale of annotation data or advertising use is implemented in the reviewed code.
- Onward processing by a configured model provider is part of the annotation workflow, as described above; these statements do not make promises about that provider's practices.

## Data storage

- The plugin writes screenshots to an `annotations/` subdirectory of its runtime directory. It uses `XDG_RUNTIME_DIR/opencode-chrome-annotation` when usable, otherwise `opencode-chrome-annotation-<uid-or-user>` under the operating system's temporary directory. Filenames include a timestamp and a sanitized page-title stem, with fallbacks when no title is available.
- The plugin implements no automatic screenshot deletion. A temporary-directory location is not a retention guarantee; files can remain until you or the operating system remove them.
- The extension stores tab claims, including session connection state, in `chrome.storage.session`, with `chrome.storage.local` as a fallback. The fallback can persist beyond a browser session, so connection state is not guaranteed to be session-only.
- Extension developer-console logs may include page URL/title, selectors, tab/session identifiers, payload size, and comment length. The plugin writes diagnostic information to `plugin.log` in its runtime directory.
- OpenCode session records and any provider-side copies have their own retention behavior. Deleting local screenshots or uninstalling the extension does not delete those copies.

## User control

- Annotation capture is user-initiated.
- You choose when to connect a tab and when to submit an annotation.
- You can remove the extension at any time from `chrome://extensions`.
- You can remove local screenshot and log files when no longer needed. Review OpenCode and provider controls separately for session data and any remote copies.
- Avoid capturing sensitive pages or sharing unredacted logs and screenshots in public support requests.

## Security

The extension communicates with a plugin bound to the loopback address `127.0.0.1`. This HTTP hop is local, not encrypted remote transport. It does not establish the security or privacy of subsequent OpenCode/provider processing or protect files from other software with access to your account or machine.

## Changes to this policy

This policy was reviewed internally before it was submitted as the privacy policy URL for the Chrome Web Store listing and is updated when data handling changes. Updates will be reflected in the date above.

## Contact

For repository support or privacy questions, use [GitHub Issues](https://github.com/asumaroks/opencode-chrome-annotation/issues). This is a public contact channel: do not post secrets or personal/confidential content.

This repository contact does not replace any publisher email required by the Chrome Web Store. The public privacy policy URL used for the store listing is this file in the repository. The publisher contact email and the store's data-category disclosures are configured in the Chrome Web Store publisher account and are not held in this repository.
