// End-to-end "canary" test for Tabbard.
//
// Loads the extension into a real browser, copies tabs and checks the system clipboard. The
// GitHub workflow in .github/workflows/browser-canary.yml runs it every week against stable
// and pre-release browsers, so a browser change that breaks Tabbard, or that pushes it onto a
// fallback, shows up before it reaches users.
//
// Usage:
//   node test/e2e.mjs --browser chrome|firefox [--channel <channel>] [--executable <path>]
//
// Channels: chrome: stable, beta, dev, canary. firefox: stable, beta, nightly, devedition, esr.
// Without --executable, the browser is downloaded into ~/.cache/tabbard-browsers, or into
// $TABBARD_BROWSER_CACHE.
//
// The test opens a visible browser window and overwrites the clipboard. On Linux it needs an
// X server (for example `xvfb-run`) and `xclip`.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { Browser, detectBrowserPlatform, install, resolveBuildId } from '@puppeteer/browsers';
import puppeteer from 'puppeteer-core';

const execFileAsync = promisify(execFile);

const EXTENSION_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MANIFEST = JSON.parse(await readFile(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
const GECKO_ID = MANIFEST.browser_specific_settings.gecko.id;
// Fixed moz-extension:// host, so that the test can open the options page in Firefox.
const FIREFOX_EXTENSION_UUID = '5ab6b1e4-7b0f-4c8e-9d63-2b5a3c0e7a11';
const SENTINEL = 'tabbard-e2e-clipboard-sentinel';
const EOL = process.platform === 'win32' ? '\r\n' : '\n';
const TIMEOUT_MS = 20_000;
const TITLE_COPY_ALL = 'Copy all tab URLs';
const TITLE_COPY_SELECTED = 'Copy selected tab URLs';

// How Tabbard should work when nothing changed in the browser. Anything else means that a
// browser change forced Tabbard onto a fallback, which the canary reports.
const EXPECTED = {
    chrome: { environment: 'service worker', strategy: 'offscreen-document' },
    firefox: { environment: 'document', strategy: 'clipboard-api' }
};

const { values: args } = parseArgs({
    options: {
        browser: { type: 'string' },
        channel: { type: 'string', default: 'stable' },
        executable: { type: 'string' }
    }
});

if (!Object.hasOwn(EXPECTED, args.browser ?? '')) {
    console.error('Usage: node test/e2e.mjs --browser chrome|firefox [--channel <channel>] [--executable <path>]');
    process.exit(2);
}

const expected = EXPECTED[args.browser];
const results = [];
let instance;
let server;
let browserVersion = `${args.browser} ${args.channel}`;

try {
    const executablePath = args.executable ?? await installBrowser(args.browser, args.channel);
    server = await startServer();
    instance = await launchBrowser(args.browser, executablePath);
    browserVersion = await instance.version();
    console.log(`Testing Tabbard in ${browserVersion}`);
    await runTests();
} catch (error) {
    results.push({ name: 'Setup', ok: false, details: describe(error) });
    console.log(`FAIL  Setup\n      ${describe(error)}`);
} finally {
    await instance?.close().catch(() => {});
    server?.close();
}

await report();
process.exitCode = results.length > 0 && results.every((result) => result.ok !== false) ? 0 : 1;

async function runTests() {
    const extensionId = await instance.installExtension(EXTENSION_DIR);
    let extensionBase;
    if (args.browser === 'chrome') {
        extensionBase = `chrome-extension://${extensionId}/`;
    } else {
        assert.equal(extensionId, GECKO_ID, 'Firefox installed the extension under an unexpected ID.');
        extensionBase = `moz-extension://${FIREFOX_EXTENSION_UUID}/`;
    }

    const optionsPage = await instance.newPage();
    await optionsPage.goto(`${extensionBase}options.html`);
    await optionsPage.waitForSelector('#dontcopytitles:not([disabled])', { timeout: TIMEOUT_MS });
    const inOptionsPage = (fn, ...fnArgs) => optionsPage.evaluate(fn, ...fnArgs);

    // Pages 1-3 open next to the options page; page 4 opens in a second window.
    const pages = [1, 2, 3, 4].map((n) => ({
        url: `http://127.0.0.1:${server.address().port}/page/${n}`,
        title: pageTitle(n)
    }));
    const block = (page) => `${page.title}${EOL}${page.url}`;
    const hasBlock = (text, page) => text.split(EOL + EOL).includes(block(page));

    await inOptionsPage(async (urls) => {
        const current = await browser.tabs.getCurrent();
        for (const url of urls.slice(0, 3)) {
            await browser.tabs.create({ url, windowId: current.windowId, active: false });
        }
        await browser.windows.create({ url: urls[3] });
        await browser.windows.update(current.windowId, { focused: true });
        await browser.tabs.update(current.id, { active: true });
    }, pages.map((page) => page.url));
    await poll('the test pages to load', () => inOptionsPage(async (titles) => {
        const tabs = await browser.tabs.query({});
        return titles.every((title) => tabs.some((tab) => tab.status === 'complete' && tab.title === title));
    }, pages.map((page) => page.title)));

    // Highlights the given URLs in the options page's window, or only the options page.
    const highlight = (urls = []) => inOptionsPage(async (urlsToHighlight) => {
        const current = await browser.tabs.getCurrent();
        const tabs = await browser.tabs.query({ windowId: current.windowId });
        const indices = urlsToHighlight.length > 0
            ? tabs.filter((tab) => urlsToHighlight.includes(tab.url)).map((tab) => tab.index)
            : [current.index];
        await browser.tabs.highlight({ windowId: current.windowId, tabs: indices });
    }, urls);

    // Copies as if the user clicked in the options page's window.
    const copy = async (message = {}) => {
        await writeClipboard(SENTINEL);
        const response = await inOptionsPage(
            (extra) => browser.runtime.sendMessage({ target: 'background', type: 'copy-tabs', ...extra }),
            message
        );
        assert.equal(response?.ok, true, `Tabbard reported a failed copy: ${response?.error ?? 'no response'}`);
        return { response, text: await waitForClipboardChange() };
    };

    const diagnostics = await inOptionsPage(() => browser.runtime.sendMessage({ target: 'background', type: 'get-diagnostics' }));
    console.log(`Background: ${diagnostics?.environment}; clipboard methods: ${diagnostics?.strategies?.join(', ')}`);

    await check('Background runs in the expected environment', async () => {
        assert.equal(diagnostics?.environment, expected.environment,
            `background.js runs as a ${diagnostics?.environment}, not as a ${expected.environment}. `
            + 'The browser changed how it runs extension background scripts.');
    });

    let firstCopy;
    await check('Copies all tabs of all windows', async () => {
        firstCopy = await copy();
        for (const page of pages) {
            assert.ok(hasBlock(firstCopy.text, page), `The clipboard lacks "${page.title}" with its URL:\n${firstCopy.text}`);
        }
        assert.ok(!firstCopy.text.endsWith(EOL), 'The copied text ends with a line break.');
    });

    await check('Uses the primary clipboard method', async () => {
        assert.ok(firstCopy, 'There is no copy to inspect.');
        assert.equal(firstCopy.response.strategy, expected.strategy,
            `Copied through the "${firstCopy.response.strategy}" fallback instead of "${expected.strategy}". `
            + 'Users still get their copy, but the primary method stopped working in this browser.');
    });

    const selection = [pages[0], pages[2]];
    const selectionText = selection.map(block).join(EOL + EOL);

    await check('Copies only the selected tabs', async () => {
        await highlight(selection.map((page) => page.url));
        const { text } = await copy();
        assert.equal(text, selectionText);
    });

    await check('Toolbar button title follows the selection', async () => {
        await highlight(selection.map((page) => page.url));
        await poll(`the title "${TITLE_COPY_SELECTED}"`, async () => (await getActionTitle()) === TITLE_COPY_SELECTED);
        await highlight();
        await poll(`the title "${TITLE_COPY_ALL}"`, async () => (await getActionTitle()) === TITLE_COPY_ALL);
    });

    // Every fallback must work too, so that it's ready on the day the primary method breaks.
    for (const strategy of diagnostics?.strategies ?? []) {
        await check(`Clipboard method "${strategy}" works`, async () => {
            await highlight(selection.map((page) => page.url));
            const { response, text } = await copy({ strategy });
            assert.equal(response.strategy, strategy);
            assert.equal(text, selectionText);
        });
    }
    await highlight();

    await check('"Do not copy site titles" option', async () => {
        await setOption('#dontcopytitles', 'dontCopyTitles', true);
        try {
            const { text } = await copy();
            const lines = text.split(EOL);
            for (const page of pages) {
                assert.ok(lines.includes(page.url), `The clipboard lacks the URL ${page.url}:\n${text}`);
                assert.ok(!text.includes(page.title), `The clipboard contains the title "${page.title}":\n${text}`);
            }
            assert.ok(!text.endsWith(EOL), 'The copied text ends with a line break.');
        } finally {
            await setOption('#dontcopytitles', 'dontCopyTitles', false);
        }
    });

    await check('"Copy only currently focused window tabs" option', async () => {
        await setOption('#copyonlycurrentwindow', 'copyOnlyCurrentWindow', true);
        try {
            const { text } = await copy();
            for (const page of pages.slice(0, 3)) {
                assert.ok(hasBlock(text, page), `The clipboard lacks "${page.title}":\n${text}`);
            }
            assert.ok(!text.includes(pages[3].url), `The clipboard contains a tab of another window:\n${text}`);
        } finally {
            await setOption('#copyonlycurrentwindow', 'copyOnlyCurrentWindow', false);
        }
    });

    if (args.browser === 'chrome') {
        await check('Toolbar button click copies the tabs', async () => {
            const extension = (await instance.extensions()).get(extensionId);
            assert.ok(extension, 'Puppeteer does not list the extension.');
            await writeClipboard(SENTINEL);
            await extension.triggerAction(optionsPage);
            const text = await waitForClipboardChange();
            for (const page of pages) {
                assert.ok(hasBlock(text, page), `The clipboard lacks "${page.title}":\n${text}`);
            }
        });
    } else {
        results.push({ name: 'Toolbar button click copies the tabs', ok: null, details: 'Skipped: WebDriver BiDi cannot click extension buttons.' });
    }

    await check('No copy failure is recorded', async () => {
        const state = await inOptionsPage(async () => ({
            lastError: (await browser.storage.local.get('lastError')).lastError ?? null,
            badge: await browser.action.getBadgeText({})
        }));
        assert.equal(state.lastError, null, `Tabbard recorded a failure: ${JSON.stringify(state.lastError)}`);
        assert.equal(state.badge, '');
    });

    function getActionTitle() {
        return inOptionsPage(() => browser.action.getTitle({}));
    }

    async function setOption(selector, key, value) {
        await inOptionsPage((checkboxSelector, checked) => {
            const checkbox = document.querySelector(checkboxSelector);
            if (checkbox.checked !== checked) {
                checkbox.click();
            }
        }, selector, value);
        await poll(`option ${key} to be ${value}`, async () => {
            const stored = await inOptionsPage(
                async (storageKey) => (await browser.storage.local.get(storageKey))[storageKey] ?? false,
                key
            );
            return stored === value;
        });
    }
}

/**
 * Runs one check and records its outcome without stopping the run.
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function check(name, fn) {
    try {
        await fn();
        results.push({ name, ok: true, details: '' });
        console.log(`PASS  ${name}`);
    } catch (error) {
        results.push({ name, ok: false, details: describe(error) });
        console.log(`FAIL  ${name}\n      ${describe(error).replaceAll('\n', '\n      ')}`);
    }
}

async function report() {
    const failed = results.filter((result) => result.ok === false).length;
    console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`} in ${browserVersion}.`);

    if (process.env.GITHUB_STEP_SUMMARY) {
        const cell = (text) => text.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>');
        const rows = results.map((result) => {
            const status = result.ok === null ? '⚪ skipped' : result.ok ? '✅ pass' : '❌ fail';
            return `| ${cell(result.name)} | ${status} | ${cell(result.details)} |`;
        });
        const summary = [
            `### Tabbard in ${browserVersion} (${args.browser} ${args.channel})`,
            '',
            '| Check | Result | Details |',
            '|---|---|---|',
            ...rows,
            '',
            ''
        ];
        await appendFile(process.env.GITHUB_STEP_SUMMARY, summary.join('\n'));
    }
}

async function installBrowser(name, channel) {
    const browserType = name === 'chrome' ? Browser.CHROME : Browser.FIREFOX;
    const platform = detectBrowserPlatform();
    if (!platform) {
        throw new Error('Browsers cannot be downloaded for this platform; pass --executable instead.');
    }
    const buildId = await resolveBuildId(browserType, platform, channel);
    console.log(`Installing ${name} ${buildId} (${channel})…`);
    const installed = await install({
        browser: browserType,
        buildId,
        buildIdAlias: channel,
        platform,
        cacheDir: process.env.TABBARD_BROWSER_CACHE ?? path.join(homedir(), '.cache', 'tabbard-browsers')
    });
    return installed.executablePath;
}

function launchBrowser(name, executablePath) {
    if (name === 'chrome') {
        // installExtension() uses the Extensions.loadUnpacked command, which needs a pipe connection.
        return puppeteer.launch({
            browser: 'chrome',
            executablePath,
            headless: false,
            pipe: true,
            enableExtensions: true,
            args: ['--no-first-run', '--no-default-browser-check']
        });
    }
    return puppeteer.launch({
        browser: 'firefox',
        executablePath,
        headless: false,
        extraPrefsFirefox: {
            'extensions.webextensions.uuids': JSON.stringify({ [GECKO_ID]: FIREFOX_EXTENSION_UUID })
        }
    });
}

function startServer() {
    const httpServer = createServer((request, response) => {
        const match = /^\/page\/(\d+)$/.exec(request.url ?? '');
        if (!match) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!DOCTYPE html><meta charset="utf-8"><title>${pageTitle(match[1])}</title><p>Tabbard test page ${match[1]}</p>`);
    });
    return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve(httpServer));
    });
}

function pageTitle(n) {
    // Non-ASCII characters check that the copied text keeps its encoding.
    return `Tabbard test page ${n} – ünïcödé ✓`;
}

/**
 * Calls fn until it returns true.
 * @param {string} what - Description for the timeout error.
 * @param {() => Promise<boolean>} fn
 */
async function poll(what, fn) {
    const deadline = Date.now() + TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
        try {
            if (await fn()) {
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${what}.${lastError ? ` Last error: ${describe(lastError)}` : ''}`);
}

async function waitForClipboardChange() {
    let text = SENTINEL;
    await poll('the clipboard to change', async () => {
        text = await readClipboard();
        return text !== SENTINEL;
    });
    return text;
}

async function readClipboard() {
    switch (process.platform) {
        case 'win32': {
            const command = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write((Get-Clipboard -Raw))';
            return (await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })).stdout;
        }
        case 'darwin':
            return (await execFileAsync('pbpaste', [], { encoding: 'utf8' })).stdout;
        default:
            return (await execFileAsync('xclip', ['-selection', 'clipboard', '-out', '-target', 'UTF8_STRING'], { encoding: 'utf8' })).stdout;
    }
}

function writeClipboard(text) {
    const [command, commandArgs] = {
        win32: ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard']],
        darwin: ['pbcopy', []]
    }[process.platform] ?? ['xclip', ['-selection', 'clipboard', '-in']];

    return new Promise((resolve, reject) => {
        // xclip keeps running in the background to serve the clipboard, so this waits for the
        // foreground process to exit rather than for its output streams to close.
        const child = spawn(command, commandArgs, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}.`))));
        child.stdin.end(text);
    });
}

function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
