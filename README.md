# Tabbard

The dead simple browser extension for Chrome and Firefox that copies the titles and URLs of your open tabs to the clipboard.

## Installation

Install from

- [Google Chrome Web Store](https://chrome.google.com/webstore/detail/tabbard/jjgomhmmlcknccaafhilfiodnfbommae)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tabbard/)

**or** enable developer mode and load the unpacked extension (Chrome), or load `manifest.json` from `about:debugging` (Firefox).

Requires Chrome 121 or later (or another Chromium-based browser of the same version), or Firefox 121 or later.

## Usage

Click the Tabbard toolbar button, or choose **Copy all tab URLs** from the page's context menu. In Firefox, and in Chrome 150 or later, the menu item is also on the context menu of tabs.

What gets copied:

- **Selected tabs:** if you selected several tabs in the window (Ctrl+click or Shift+click on tabs; ⌘+click on macOS), only those tabs are copied. The button tooltip and the menu item then read **Copy selected tab URLs**.
- **Otherwise:** the tabs of all open windows, or only of the current window if that option is enabled.

Each tab is copied as its title followed by its URL on the next line, with an empty line between tabs. Lines end with CRLF on Windows and LF elsewhere.

If copying fails, the toolbar button shows a red **!** badge, and its tooltip points to the options page. The options page shows what went wrong and offers a **Report this problem on GitHub** link, which opens a pre-filled issue with technical details only, never your tabs. Nothing is sent unless you submit that issue. Click the button again to retry; the badge disappears after the next successful copy.

## Options

- **Do not copy site titles:** copy one URL per line, without titles.
- **Copy only currently focused window tabs:** copy the tabs of the window where you clicked, instead of all windows.

## How Tabbard keeps working when browsers change

Chrome runs `background.js` as a service worker and Firefox runs it as an event page, and both keep changing what these contexts may do. Tabbard never checks which browser it runs in. Before it uses an API, it checks that the API exists:

- **Clipboard methods:** Tabbard tries them in this order and uses the first one that works:
  1. the Clipboard API
  2. `document.execCommand('copy')`
  3. an offscreen document, which is Chrome's way
  4. as a last resort, `clipboard.html` opened in an inactive tab that closes by itself

  After that, it starts with the method that worked last.
- **Background environment:** the manifest asks browsers that support both kinds of background context to keep the event page (`preferred_environment`).
- **Missing APIs:** if an optional browser API is missing, only its feature stops working, not the whole extension.

The [Browser canary](.github/workflows/browser-canary.yml) workflow checks this every Monday. It loads Tabbard into Chrome stable, beta and canary, and Firefox ESR, stable, beta and nightly, then copies tabs with every available clipboard method and checks the system clipboard. If a check fails, or a browser change pushes Tabbard onto a fallback, the workflow opens a GitHub issue labeled `browser-canary`. It closes the issue when everything passes again. Problems in beta, canary and nightly builds show up weeks before those versions reach users.

## Development

```sh
npm install
npm run lint             # ESLint
npm run lint:extension   # web-ext lint (Firefox / AMO rules)
npm run package          # Builds the extension package into dist/
npm run test:e2e -- --browser chrome                     # Canary on this computer
npm run test:e2e -- --browser firefox --channel nightly
```

The end-to-end test downloads the browser into `~/.cache/tabbard-browsers`, opens a visible window and overwrites the clipboard, so leave the computer alone while it runs. On Linux it needs an X server, such as `xvfb-run`, and `xclip`. Run `node test/e2e.mjs` without arguments to see its options.

### Expected warnings

Chrome and Firefox share one `manifest.json`, so each browser warns about the parts meant for the other one. Each browser ignores the part it warns about and loads the rest, so these warnings need no fix:

- **Chrome** (`chrome://extensions`): `'background.scripts' requires manifest version of 2 or lower.` Firefox needs `background.scripts` to run `background.js` as an event page. Chrome ignores it because `background.service_worker` is also set, and runs the service worker.
- **Firefox** (`about:debugging` and the Browser Console): `Warning processing permissions: Error processing permissions.2: Value "offscreen" must either: …` Chrome needs the `offscreen` permission for its offscreen document. Firefox doesn't have the offscreen API, and [Mozilla doesn't plan to add it](https://bugzilla.mozilla.org/show_bug.cgi?id=1807830). Tabbard checks that the API exists before using it, so Firefox skips that clipboard method.
- **`npm run lint:extension`:** reports the same `offscreen` permission and API calls. It also reports that `data_collection_permissions` needs Firefox 140 or later (142 on Android); older versions ignore the key. These are warnings, not errors, and don't block publishing on Firefox Add-ons.

A separate manifest for each browser would remove these warnings, but would need a build step for each browser. You also couldn't load the folder straight into the browser any more.
