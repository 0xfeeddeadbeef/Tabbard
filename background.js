/*
Copyright (c) 2024 George Chakhidze

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/*
The offscreen document clipboard code is derived from the "cookbook.offscreen-clipboard-write"
sample, Copyright 2023 Google LLC, licensed under the Apache License, Version 2.0:
https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.offscreen-clipboard-write
*/

'use strict';

// This script runs as a service worker in Chrome and as an event page in Firefox (see
// "background" in manifest.json), and browsers keep changing what each context may do.
// So it never asks which browser it runs in. It checks for each capability right before
// using it, and falls back to the next way of doing the same thing.

// Chrome before 148 only exposes `chrome.*`; its Manifest V3 methods return promises too.
if (!globalThis.browser) {
    globalThis.browser = chrome;
}

const MENU_ITEM_ID = 'c49bb168-99b0-479f-b560-30c6b4cc067a';
const TITLE_COPY_ALL = 'Copy all tab URLs'; // Must match "default_title" in manifest.json.
const TITLE_COPY_SELECTED = 'Copy selected tab URLs';
const TITLE_ERROR_HINT = '\nThe last copy failed. Open the Tabbard options for details.';
const DEFAULT_OPTIONS = { dontCopyTitles: false, copyOnlyCurrentWindow: false };
const CLIPBOARD_PAGE_PATH = 'clipboard.html';
const ERROR_BADGE_COLOR = '#d93025';
const STRATEGY_TIMEOUT_MS = 10_000;
// Strategies that open a page need time to load it, and then up to STRATEGY_TIMEOUT_MS for the reply.
const PAGE_STRATEGY_TIMEOUT_MS = 25_000;
const ENVIRONMENT = typeof document === 'undefined' ? 'service worker' : 'document';

// Firefox offers the same API as `browser.menus` too, but that name needs the "menus" permission.
const menus = browser.contextMenus ?? browser.menus;

/**
 * Ways to write to the clipboard, in order of preference. Each one is tried only if its
 * API exists, and the next one is tried if it fails.
 * @type {{name: string, timeoutMs: number, isAvailable: () => boolean,
 *     write: (text: string, context: {windowId?: number}) => Promise<void>}[]}
 */
const CLIPBOARD_STRATEGIES = [
    {
        // Firefox event page. Also extension service workers, if browsers ever expose the API there.
        name: 'clipboard-api',
        timeoutMs: STRATEGY_TIMEOUT_MS,
        isAvailable: () => typeof globalThis.navigator?.clipboard?.writeText === 'function',
        write: (text) => navigator.clipboard.writeText(text)
    },
    {
        // Any background context with a DOM, if the Clipboard API is missing or refuses to write.
        name: 'exec-command',
        timeoutMs: STRATEGY_TIMEOUT_MS,
        isAvailable: () => typeof globalThis.document?.execCommand === 'function',
        write: writeViaExecCommand
    },
    {
        // Chrome: service workers have no DOM, so an invisible offscreen document does the copy.
        name: 'offscreen-document',
        timeoutMs: PAGE_STRATEGY_TIMEOUT_MS,
        isAvailable: () => typeof browser.offscreen?.createDocument === 'function',
        write: writeViaOffscreenDocument
    },
    {
        // Last resort, for example a service worker without offscreen documents: an inactive tab.
        name: 'helper-tab',
        timeoutMs: PAGE_STRATEGY_TIMEOUT_MS,
        isAvailable: () => typeof browser.tabs?.create === 'function',
        write: writeViaHelperTab
    }
];

// Caches only. The background context can be stopped between events at any time.
let lastMenuTitle;
let lastActionTitle;
let copyFailed;
let lineBreak;
let preferredStrategy;
let clipboardQueue = Promise.resolve();
const clipboardPageWaiters = new Map();

// Listeners are registered synchronously at the top level, so that their events can start
// the background context. The toolbar button goes first, and a missing optional API only
// disables its own feature instead of stopping the whole script.

listen(browser.action?.onClicked, 'action.onClicked', (tab) => {
    runCopy(tab);
});

listen(menus?.onClicked, 'contextMenus.onClicked', (info, tab) => {
    if (info.menuItemId === MENU_ITEM_ID) {
        runCopy(tab);
    }
});

listen(browser.runtime.onInstalled, 'runtime.onInstalled', () => {
    initialize({ createMenu: true }).catch(console.error);
});

listen(browser.runtime.onStartup, 'runtime.onStartup', () => {
    initialize({ createMenu: false }).catch(console.error);
});

listen(browser.runtime.onMessage, 'runtime.onMessage', handleMessage);

listen(browser.storage?.onChanged, 'storage.onChanged', (changes, areaName) => {
    if (areaName === 'local' && 'lastError' in changes) {
        showCopyFailed(changes.lastError.newValue !== undefined).catch(console.error);
    }
});

listen(browser.tabs?.onHighlighted, 'tabs.onHighlighted', ({ tabIds }) => {
    setTitles(getTitle(tabIds.length)).catch(console.error);
});

// The titles describe the selection of the focused window, which changes with the window.
listen(browser.windows?.onFocusChanged, 'windows.onFocusChanged', (windowId) => {
    if (windowId !== browser.windows.WINDOW_ID_NONE) {
        syncTitles({ windowId }).catch(console.error);
    }
});

/**
 * Adds an event listener if the browser has the event.
 * @param {object | undefined} event
 * @param {string} name - Event name for the log.
 * @param {Function} listener
 */
function listen(event, name, listener) {
    if (typeof event?.addListener !== 'function') {
        console.warn(`Tabbard: ${name} is not available in this browser. The feature that needs it is off.`);
        return;
    }
    try {
        event.addListener(listener);
    } catch (error) {
        console.error(`Tabbard: could not listen to ${name}.`, error);
    }
}

/**
 * Handles messages from Tabbard's own pages.
 * @returns {true | undefined} `true` when the reply is sent asynchronously.
 */
function handleMessage(message, sender, sendResponse) {
    if (message?.target !== 'background' || !isOwnPage(sender)) {
        return undefined;
    }
    switch (message.type) {
        case 'clipboard-page-ready':
            clipboardPageWaiters.get(message.session)?.();
            return undefined;
        case 'get-diagnostics':
            sendResponse({
                environment: ENVIRONMENT,
                strategies: getAvailableStrategies().map((strategy) => strategy.name)
            });
            return undefined;
        case 'copy-tabs':
            // Lets the automated browser tests copy as if the user clicked in the sender's window,
            // optionally with one specific clipboard strategy to check that each fallback works.
            runCopy(sender.tab, { strategy: message.strategy }).then(sendResponse);
            return true;
        default:
            return undefined;
    }
}

/**
 * @param {object} sender - `runtime.MessageSender`.
 * @returns {boolean} Whether the message comes from a page of this extension.
 */
function isOwnPage(sender) {
    return sender.id === browser.runtime.id
        && typeof sender.url === 'string'
        && sender.url.startsWith(browser.runtime.getURL(''));
}

/**
 * Brings the context menu item, both titles and the error badge up to date after an
 * install, an update or a browser start. Menu items keep their last title across browser
 * restarts, but the toolbar button tooltip and badge go back to their defaults.
 * @param {{createMenu: boolean}} options
 * @returns {Promise<void>}
 */
async function initialize({ createMenu }) {
    if (createMenu) {
        await createContextMenu();
    }
    const { lastError } = await browser.storage.local.get({ lastError: null });
    await showCopyFailed(lastError !== null);
}

/**
 * Creates the context menu item from scratch.
 * `runtime.onInstalled` also fires after browser updates, when the persisted item already
 * exists, so the old item is removed first.
 * @returns {Promise<void>}
 */
async function createContextMenu() {
    if (!menus) {
        return;
    }
    await menus.removeAll();
    await createMenuItem({
        id: MENU_ITEM_ID,
        title: TITLE_COPY_ALL,
        contexts: supportsTabContext() ? ['tab', 'page'] : ['page']
    });
}

/**
 * Promise wrapper for `contextMenus.create()`, which reports errors only to its callback.
 * @param {object} properties - Properties of the new menu item.
 * @returns {Promise<void>}
 */
function createMenuItem(properties) {
    return new Promise((resolve, reject) => {
        menus.create(properties, () => {
            const error = browser.runtime.lastError;
            if (error) {
                reject(new Error(error.message));
            } else {
                resolve();
            }
        });
    });
}

/**
 * Determines whether menu items can be added to the tab strip's context menu.
 * Firefox and Chrome 150+ support the 'tab' context; older Chromium rejects unknown contexts.
 * @returns {boolean}
 */
function supportsTabContext() {
    const types = menus.ContextType;
    return !types || Object.values(types).includes('tab');
}

/**
 * Returns the title that describes what a click copies.
 * @param {number} highlightedCount - Number of highlighted tabs in the window.
 * @returns {string}
 */
function getTitle(highlightedCount) {
    return highlightedCount > 1 ? TITLE_COPY_SELECTED : TITLE_COPY_ALL;
}

/**
 * Updates both titles from the last focused window, even when the cached titles match.
 * @returns {Promise<void>}
 */
function resyncTitles() {
    lastMenuTitle = undefined;
    lastActionTitle = undefined;
    return syncTitles({ lastFocusedWindow: true });
}

/**
 * Updates both titles from the selection in the window that matches the query.
 * @param {{windowId: number} | {lastFocusedWindow: boolean}} windowQuery
 * @returns {Promise<void>}
 */
async function syncTitles(windowQuery) {
    const highlighted = await browser.tabs.query({ ...windowQuery, highlighted: true });
    await setTitles(getTitle(highlighted.length));
}

/**
 * Shows the selection title in the context menu item, and in the toolbar button tooltip
 * together with a hint while the last copy has failed.
 * `tabs.onHighlighted` fires on every tab switch, so titles that didn't change are skipped.
 * @param {string} selectionTitle
 * @returns {Promise<void>}
 */
async function setTitles(selectionTitle) {
    const actionTitle = (await isCopyFailed()) ? selectionTitle + TITLE_ERROR_HINT : selectionTitle;
    const updates = [];

    if (menus && selectionTitle !== lastMenuTitle) {
        lastMenuTitle = selectionTitle;
        // Chrome 121-122 returns undefined instead of a promise here.
        updates.push(Promise.resolve(menus.update(MENU_ITEM_ID, { title: selectionTitle })).catch((error) => {
            lastMenuTitle = undefined; // Retry on the next event.
            throw error;
        }));
    }
    if (actionTitle !== lastActionTitle) {
        lastActionTitle = actionTitle;
        updates.push(browser.action.setTitle({ title: actionTitle }).catch((error) => {
            lastActionTitle = undefined; // Retry on the next event.
            throw error;
        }));
    }

    await Promise.all(updates);
}

/**
 * @returns {Promise<boolean>} Whether the last copy failed. Read from storage once per
 *     background lifetime, then kept current by `storage.onChanged`.
 */
async function isCopyFailed() {
    if (copyFailed === undefined) {
        const { lastError } = await browser.storage.local.get({ lastError: null });
        copyFailed ??= lastError !== null;
    }
    return copyFailed;
}

/**
 * Shows or hides the error badge and the tooltip hint.
 * @param {boolean} failed
 * @returns {Promise<void>}
 */
async function showCopyFailed(failed) {
    copyFailed = failed;
    const badge = failed
        ? Promise.all([
            browser.action.setBadgeBackgroundColor({ color: ERROR_BADGE_COLOR }),
            browser.action.setBadgeText({ text: '!' })
        ])
        : browser.action.setBadgeText({ text: '' });
    await Promise.all([badge, resyncTitles()]);
}

/**
 * Copies the tabs and records the outcome. A failure is saved for the options page and
 * shown on the toolbar button; a success clears an earlier failure.
 * @param {object} [tab] - Tab where the toolbar button or the menu item was clicked.
 * @param {{strategy?: string}} [options] - Forces one clipboard strategy. Used by tests only,
 *     so the outcome isn't recorded.
 * @returns {Promise<{ok: boolean, environment: string, strategy?: string, error?: string}>}
 */
async function runCopy(tab, { strategy: forcedStrategy } = {}) {
    let strategy;
    try {
        strategy = await copyTabs(tab, forcedStrategy);
    } catch (error) {
        console.error('Tabbard could not copy the tabs.', error);
        if (!forcedStrategy) {
            await recordCopyError(error).catch(console.error);
        }
        return { ok: false, environment: ENVIRONMENT, error: describeError(error) };
    }

    // storage.onChanged then clears the badge and the tooltip hint.
    if (!forcedStrategy && await isCopyFailed().catch(() => true)) {
        await browser.storage.local.remove('lastError').catch(console.error);
    }
    return { ok: true, environment: ENVIRONMENT, strategy };
}

/**
 * Copies titles and URLs of the selected tabs, of the current window's tabs, or of all tabs.
 * @param {object} [clickedTab] - Tab where the toolbar button or the menu item was clicked.
 *     `contextMenus.onClicked` doesn't always provide one.
 * @param {string} [forcedStrategy] - Name of the only clipboard strategy to try.
 * @returns {Promise<string | undefined>} Name of the clipboard strategy that worked, or
 *     undefined when there was nothing to copy.
 */
async function copyTabs(clickedTab, forcedStrategy) {
    const [options, eol, currentWindow] = await Promise.all([
        browser.storage.local.get(DEFAULT_OPTIONS),
        getLineBreak(),
        clickedTab
            ? browser.windows.get(clickedTab.windowId, { populate: true })
            : browser.windows.getLastFocused({ populate: true })
    ]);

    // A multi-tab selection always belongs to a single window, and takes precedence.
    const selection = currentWindow.tabs.filter((tab) => tab.highlighted);
    let tabs;
    if (selection.length > 1) {
        tabs = selection;
    } else if (options.copyOnlyCurrentWindow) {
        tabs = currentWindow.tabs;
    } else {
        const windows = await browser.windows.getAll({ populate: true });
        tabs = windows.flatMap((win) => win.tabs);
    }

    const entries = tabs.map((tab) => {
        // `url` stays empty until a navigation commits; Chrome has the target in `pendingUrl` meanwhile.
        const url = tab.url || tab.pendingUrl || '';
        return options.dontCopyTitles ? url : `${tab.title ?? ''}${eol}${url}`;
    });
    const text = entries.join(options.dontCopyTitles ? eol : eol + eol);

    return text ? writeToClipboard(text, { windowId: currentWindow.id }, forcedStrategy) : undefined;
}

/**
 * Returns the line break of the user's platform: CRLF on Windows, LF elsewhere.
 * @returns {Promise<string>}
 */
async function getLineBreak() {
    if (!lineBreak) {
        const { os } = await browser.runtime.getPlatformInfo();
        lineBreak = os === 'win' ? '\r\n' : '\n';
    }
    return lineBreak;
}

/**
 * Writes text to the clipboard. Writes run one at a time, so that overlapping clicks never
 * race for the single offscreen document that Chrome allows.
 * @param {string} text
 * @param {{windowId?: number}} context - Window where the user clicked.
 * @param {string} [forcedStrategy] - Name of the only strategy to try.
 * @returns {Promise<string>} Name of the strategy that worked.
 */
function writeToClipboard(text, context, forcedStrategy) {
    const write = () => writeWithFirstWorkingStrategy(text, context, forcedStrategy);
    clipboardQueue = clipboardQueue.then(write, write);
    return clipboardQueue;
}

/**
 * @returns {object[]} The clipboard strategies whose APIs exist in this context.
 */
function getAvailableStrategies() {
    return CLIPBOARD_STRATEGIES.filter((strategy) => strategy.isAvailable());
}

/**
 * Tries the available clipboard strategies until one works, starting with the one that
 * worked last time.
 * @param {string} text
 * @param {{windowId?: number}} context
 * @param {string} [forcedStrategy] - Name of the only strategy to try.
 * @returns {Promise<string>} Name of the strategy that worked.
 */
async function writeWithFirstWorkingStrategy(text, context, forcedStrategy) {
    const strategies = getAvailableStrategies()
        .filter((strategy) => !forcedStrategy || strategy.name === forcedStrategy)
        .sort((a, b) => (b.name === preferredStrategy) - (a.name === preferredStrategy));

    const errors = [];
    for (const strategy of strategies) {
        try {
            await withTimeout(strategy.write(text, context), strategy.timeoutMs, 'Timed out.');
        } catch (error) {
            errors.push(new Error(`${strategy.name}: ${error?.message ?? error}`, { cause: error }));
            continue;
        }
        if (errors.length > 0) {
            console.warn(`Tabbard: copied with "${strategy.name}" after other methods failed.`, errors);
        }
        if (!forcedStrategy) {
            preferredStrategy = strategy.name;
        }
        return strategy.name;
    }

    throw new AggregateError(errors, strategies.length > 0
        ? 'Every clipboard method failed.'
        : 'This browser offers no clipboard method that Tabbard can use.');
}

/**
 * Rejects if the promise doesn't settle in time.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Copies through a temporary <textarea> in this context's own document.
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeViaExecCommand(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    (document.body ?? document.documentElement).append(textarea);
    try {
        textarea.select();
        if (!document.execCommand('copy')) {
            throw new Error('document.execCommand("copy") returned false.');
        }
    } finally {
        textarea.remove();
    }
}

/**
 * Copies through clipboard.html opened as an offscreen document, then closes the document.
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeViaOffscreenDocument(text) {
    const options = {
        url: CLIPBOARD_PAGE_PATH,
        reasons: [browser.offscreen.Reason?.CLIPBOARD ?? 'CLIPBOARD'],
        justification: 'Write text to the clipboard.'
    };
    try {
        await browser.offscreen.createDocument(options);
    } catch (error) {
        // Only one offscreen document may exist. One is left over if the service worker was
        // stopped before it could close it, so close that one and try again.
        await browser.offscreen.closeDocument().catch(() => {
            throw error;
        });
        await browser.offscreen.createDocument(options);
    }

    try {
        await withTimeout(sendToClipboardPage(text, null), STRATEGY_TIMEOUT_MS, 'The offscreen document did not reply.');
    } finally {
        // A failure to close must not hide the result of the copy.
        await browser.offscreen.closeDocument().catch(console.error);
    }
}

/**
 * Copies through clipboard.html opened in an inactive tab, then closes the tab.
 * @param {string} text
 * @param {{windowId?: number}} context
 * @returns {Promise<void>}
 */
async function writeViaHelperTab(text, { windowId }) {
    const session = crypto.randomUUID();
    const ready = waitForClipboardPage(session, STRATEGY_TIMEOUT_MS);
    let tabId;
    try {
        const tab = await browser.tabs.create({
            url: browser.runtime.getURL(`${CLIPBOARD_PAGE_PATH}?session=${session}`),
            active: false,
            ...(windowId === undefined ? {} : { windowId })
        });
        tabId = tab.id;
        await ready.promise;
        await withTimeout(sendToClipboardPage(text, session), STRATEGY_TIMEOUT_MS, 'The helper tab did not reply.');
    } finally {
        ready.cancel();
        if (tabId !== undefined) {
            await browser.tabs.remove(tabId).catch(console.error);
        }
    }
}

/**
 * Waits for the 'clipboard-page-ready' message of the helper tab with this session.
 * @param {string} session
 * @param {number} timeoutMs
 * @returns {{promise: Promise<void>, cancel: () => void}}
 */
function waitForClipboardPage(session, timeoutMs) {
    let timer;
    const promise = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The helper tab did not load in time.')), timeoutMs);
        clipboardPageWaiters.set(session, resolve);
    });
    const cancel = () => {
        clearTimeout(timer);
        clipboardPageWaiters.delete(session);
    };
    return { promise, cancel };
}

/**
 * Sends text to clipboard.html and waits for its reply.
 * @param {string} text
 * @param {string | null} session - Session of the helper tab, or null for the offscreen document.
 * @returns {Promise<void>}
 */
async function sendToClipboardPage(text, session) {
    const reply = await browser.runtime.sendMessage({
        target: 'clipboard-page',
        type: 'copy-data-to-clipboard',
        session,
        data: text
    });
    if (reply?.ok !== true) {
        throw new Error(`The clipboard page could not copy: ${reply?.error ?? 'no reply'}.`);
    }
}

/**
 * Saves a failed copy for the options page, which offers to report it.
 * The record holds diagnostics only, never tab titles or URLs, and it stays on the device.
 * @param {unknown} error
 * @returns {Promise<void>}
 */
async function recordCopyError(error) {
    const [browserName, os] = await Promise.all([describeBrowser(), describePlatform()]);
    const lastError = {
        time: new Date().toISOString(),
        message: describeError(error),
        extensionVersion: browser.runtime.getManifest().version,
        browser: browserName,
        os,
        environment: ENVIRONMENT
    };
    try {
        await browser.storage.local.set({ lastError });
    } catch (storageError) {
        console.error(storageError);
        await showCopyFailed(true); // storage.onChanged won't do it.
    }
}

/**
 * @param {unknown} error
 * @returns {string} Readable description, including the causes of an AggregateError.
 */
function describeError(error) {
    if (error instanceof AggregateError) {
        return [error.message, ...error.errors.map((inner) => `- ${describeError(inner)}`)].join('\n');
    }
    return typeof error?.message === 'string' ? error.message : String(error);
}

/**
 * @returns {Promise<string>} Browser name and version, as precise as the browser reveals.
 */
async function describeBrowser() {
    try {
        if (typeof browser.runtime.getBrowserInfo === 'function') {
            const info = await browser.runtime.getBrowserInfo();
            return `${info.name} ${info.version} (build ${info.buildID})`;
        }
        const values = await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']);
        const brands = values?.fullVersionList?.filter((brand) => !/not.?a.?brand/i.test(brand.brand));
        if (brands?.length) {
            return brands.map((brand) => `${brand.brand} ${brand.version}`).join(', ');
        }
    } catch {
        // Fall back to the user agent string.
    }
    return navigator.userAgent;
}

/**
 * @returns {Promise<string>} Operating system and architecture.
 */
async function describePlatform() {
    try {
        const { os, arch } = await browser.runtime.getPlatformInfo();
        return `${os} ${arch}`;
    } catch {
        return 'unknown';
    }
}
