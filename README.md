# <img src="https://raw.githubusercontent.com/asumaroks/opencode-chrome-annotation/main/icon.svg" width="60" align="center" /> OpenCode Chrome Annotation

[![license](https://img.shields.io/badge/license-GPL--3.0--only-000000?style=flat)](https://github.com/asumaroks/opencode-chrome-annotation/blob/main/LICENSE)

Annotate any page in Chrome and send the screenshot, selected element metadata, and your instruction directly into [OpenCode](https://opencode.ai).

This is an independent, modified distribution maintained by [asumaroks](https://github.com/asumaroks/opencode-chrome-annotation), based on [the upstream project](https://github.com/jodusnodus/opencode-chrome-annotation) by Benjamin Shafii. It is not the upstream Chrome Web Store distribution. Modification notice: 2026-10-27; see [MODIFICATIONS.json](MODIFICATIONS.json). Original authorship and copyright notices are retained, and the project remains licensed under [GPL-3.0-only](LICENSE).

https://github.com/user-attachments/assets/bdee8a15-6720-4e57-b28d-ee6440722b71


## Install

This package uses the OpenCode V2 plugin API and targets OpenCode V2.1.4. V1 `plugin` configuration is not supported. Add the package to the V2 `plugins` list:

### OpenCode V2 installation

```json
{"plugins":["opencode-chrome-annotation@git+https://github.com/asumaroks/opencode-chrome-annotation.git"]}
```

### Chrome extension installation

A separate Chrome Web Store listing for this distribution has been created and submitted for review. It is still awaiting Chrome Web Store approval, so it is not publicly available and has no store URL to link here yet. The existing listing with ID `abeihanpaeioklkhioiigklonbomhjfd` belongs to upstream, not this repository.

For now, build and load this distribution as an unpacked extension:

1. Check out this repository and install dependencies with `bun install`.
2. Run `bun run build:zip` to create `release/opencode-chrome-annotation-extension.zip`.
3. Extract the ZIP to a directory you intend to keep.
4. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted directory containing `manifest.json`.

The build also generates `extension/`, which can be loaded directly during development. Building a ZIP does not publish the extension to the Chrome Web Store.

## How It Works

1. Start OpenCode in your project.
2. Click the extension button in Chrome.
3. Connect the current tab to your OpenCode session from the in-page picker.
4. Click **Annotate** in the in-page pill.
5. Select an element, write your instruction, and submit.
6. To share a tab without annotating, right-click anywhere on the page and choose **Share this tab with OpenCode**. The current tab is sent to your OpenCode session: page URL and title, a screenshot of the visible area, and any text you had selected when you opened the menu. No element selection and no written instruction are included. If the tab is not connected yet, it is connected first; when several sessions are available, the session picker opens in share mode.


### What Gets Sent

- Your written instruction.
- The current page URL and title.
- Selected element metadata such as selector, tag, text, role, aria label, and bounds.
- Viewport dimensions and device pixel ratio.
- A PNG screenshot of the visible tab, not just the selected element.
- Routing information including the tab ID, selected session ID, and extension version.

Tab sharing sends:

- The current page URL and title.
- A PNG screenshot of the visible tab area.
- Viewport dimensions and device pixel ratio.
- Selected text, only when text was selected at the moment the menu item was used.
- Routing information including the tab ID, selected session ID, and extension version.

Element metadata is not sent when you share a tab, because that flow has no element selection and no written instruction.

The **Share this tab with OpenCode** item is registered through the extension's `contextMenus` permission and is used only for that page menu item.

The extension sends this payload to the selected plugin's local HTTP API at `127.0.0.1:39240-39260`. The plugin saves the screenshot in its local runtime `annotations/` directory and calls `context.session.prompt` with the annotation text and screenshot file attachment. OpenCode then processes that context through your configured model provider, which may be remote. This is not a guarantee of local-only processing.

Both `/annotation` and `/share` reject requests that carry an `http(s)` Origin header with `403`, so a web page cannot drive-by queue a prompt. Requests without an Origin header, and requests from `chrome-extension://` origins, are accepted.

The plugin does not automatically delete screenshot files. Connection claims use `chrome.storage.session`, with `chrome.storage.local` as a fallback; diagnostic logs may also contain page and connection metadata. Review the [privacy policy](https://github.com/asumaroks/opencode-chrome-annotation/blob/main/PRIVACY_POLICY.md) and your OpenCode/provider settings before submitting sensitive content.


### Troubleshooting
The plugin runs a local HTTP server bound to `127.0.0.1` on ports `39240-39260`. The extension discovers the active OpenCode plugin instance over localhost.

- The extension can't start a new session, you need to be in an active OpenCode session to connect.
- If the extension can't find any session, ask your agent to run `chrome_status` that should give a detailed report.
- Make sure OpenCode and your Chromium browser exist in the same localhost network (not in seperate containers).
- If the menu item reports `Update the OpenCode plugin: this version does not support tab sharing`, the installed local plugin is older than the extension. Update the `opencode-chrome-annotation` npm package to a version that supports the `/share` endpoint, then restart OpenCode.


## Development

### Plugin

The OpenCode plugin source lives in `src/plugin.ts`. The published package entrypoint is generated at `dist/plugin.js`.

Install dependencies:

```bash
bun install
```

Build the plugin:

```bash
bun run build:plugin
```

Run the plugin checks:

```bash
bun run typecheck
bun run test
```

### Extension

The Chrome extension source lives in `extension-src/`. The loadable extension output is generated into `extension/` and is not tracked by git.

```bash
bun run build:extension
```

Then load the generated `extension/` directory from `chrome://extensions`.

To create the Chrome Web Store upload zip:

```bash
bun run build:zip
```

## Support and privacy

Report problems or ask repository privacy questions through [GitHub Issues](https://github.com/asumaroks/opencode-chrome-annotation/issues). Issues are public; do not include secrets, private page content, or unredacted screenshots.

The [privacy policy](https://github.com/asumaroks/opencode-chrome-annotation/blob/main/PRIVACY_POLICY.md) is this distribution's published privacy policy, not a legal compliance guarantee. A new store listing has been created and submitted for Chrome Web Store review and is not public until that review is approved; releasing it afterwards is a manual step. The publisher contact email and store privacy disclosures live in the Chrome Web Store publisher account, not in this repository. The public issue tracker is a repository contact, not a substitute for the store's publisher email field.
