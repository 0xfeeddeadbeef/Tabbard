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
Derived from the "cookbook.offscreen-clipboard-write" sample, Copyright 2023 Google LLC,
licensed under the Apache License, Version 2.0:
https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.offscreen-clipboard-write
*/

'use strict';

// Chrome before 148 only exposes `chrome.*`; its Manifest V3 methods return promises too.
if (!globalThis.browser) {
    globalThis.browser = chrome;
}

// background.js loads this page when its own context can't write to the clipboard:
// - as a Chrome offscreen document, without a session;
// - as an inactive tab with `?session=<id>`, when no other clipboard method works.
// Either way it receives the text in a message, copies it and replies with the outcome.
const session = new URLSearchParams(location.search).get('session');

// A <textarea> keeps line breaks intact and can select its whole content.
const textEl = document.querySelector('#text');

// Registered synchronously, so it's ready when `offscreen.createDocument()` resolves.
// It replies only to messages meant for this page, and ignores the rest.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'clipboard-page'
        || message.type !== 'copy-data-to-clipboard'
        || (message.session ?? null) !== session) {
        return;
    }

    copyText(message.data).then(
        (method) => sendResponse({ ok: true, method }),
        (error) => sendResponse({ ok: false, error: String(error?.message ?? error) })
    );
    return true; // The reply is sent asynchronously.
});

if (session) {
    browser.runtime.sendMessage({ target: 'background', type: 'clipboard-page-ready', session }).catch(() => {
        // Nothing to do: background.js times out and closes this tab.
    });
}

/**
 * Copies text with the first method that works.
 * `execCommand('copy')` goes first because, unlike the Clipboard API, it works in documents
 * that don't have focus, such as offscreen documents and inactive tabs.
 * @param {string} text
 * @returns {Promise<string>} Name of the method that worked.
 */
async function copyText(text) {
    if (typeof text !== 'string') {
        throw new TypeError(`Expected a string, got ${typeof text}.`);
    }

    const failures = [];
    try {
        if (copyWithExecCommand(text)) {
            return 'exec-command';
        }
        failures.push('document.execCommand("copy") returned false');
    } catch (error) {
        failures.push(`document.execCommand("copy") failed: ${error?.message ?? error}`);
    }

    if (typeof navigator.clipboard?.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return 'clipboard-api';
        } catch (error) {
            failures.push(`navigator.clipboard.writeText() failed: ${error?.message ?? error}`);
        }
    } else {
        failures.push('navigator.clipboard.writeText() is not available');
    }

    throw new Error(failures.join('; '));
}

/**
 * @param {string} text
 * @returns {boolean} Whether the browser reported a successful copy.
 */
function copyWithExecCommand(text) {
    if (typeof document.execCommand !== 'function') {
        throw new Error('document.execCommand() is not available');
    }
    textEl.value = text;
    textEl.select();
    try {
        return document.execCommand('copy');
    } finally {
        textEl.value = '';
    }
}
