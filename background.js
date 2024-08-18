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

'use strict';

const TABBARD_CONTEXT_MENU_ITEM_ID = 'c49bb168-99b0-479f-b560-30c6b4cc067a';
const TABBARD_CONTEXT_MENU_ITEM_COPY_ALL = 'Copy all tab URLs';
const TABBARD_CONTEXT_MENU_ITEM_COPY_SELECTED = 'Copy selected tab URLs';

let copyText = [];

chrome.action.onClicked.addListener((tab) => {
    start();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === TABBARD_CONTEXT_MENU_ITEM_ID) {
        start(tab);
    }
});

/**
 * Event handler for the extension tool bar icon.
 * @param {Object} tab - Unused. Currently focused tab.
 */
async function start(tab) {
    copyText = [];

    await chrome.storage.local.get(['copyOnlyCurrentWindow'], async function (items) {
        let copyOnlyCurrentWindow = items ? items.copyOnlyCurrentWindow : false;
        if (copyOnlyCurrentWindow) {
            await chrome.windows.getCurrent({
                'populate': true,
                'windowTypes': ['normal', 'popup']
            }, async function (win) {
                await getAllTabs([win]);
            })
        } else {
            await chrome.windows.getAll({
                'populate': true,
                'windowTypes': ['normal', 'popup']
            }, getAllTabs);
        }
    });
}

/**
 * Determines whether there exist additional highlighted tabs except the active ones.
 * @param {Object[]} windows - The array of windows.
 */
function isAnyTabHighlighted(windows) {
    const numWindows = windows.length;

    for (let i = 0; i < numWindows; i++) {
        const win = windows[i];
        const numTabs = win.tabs.length;
        for (let j = 0; j < numTabs; j++) {
            const tab = win.tabs[j];
            if (!tab.active && tab.highlighted) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Copies URLs of specified windows.
 * @param {Object[]} windows - The array of browser windows.
 */
async function getAllTabs(windows) {
    await chrome.storage.local.get(['dontCopyTitles'], async function (items) {
        let dontCopyTitles = items ? items.dontCopyTitles : false;
        let isAnyTabHighlightedExceptActiveOnes = isAnyTabHighlighted(windows);
        const numWindows = windows.length;

        for (let i = 0; i < numWindows; i++) {
            const win = windows[i];
            const numTabs = win.tabs.length;
            for (let j = 0; j < numTabs; j++) {
                const tab = win.tabs[j];
                if (isAnyTabHighlightedExceptActiveOnes && !tab.highlighted) {
                    continue;
                }
                if (dontCopyTitles) {
                    copyText.push(tab.url + '\r\n');
                } else {
                    copyText.push(tab.title + '\r\n' + tab.url + '\r\n\r\n');
                }
            }
        }

        if (copyText) {
            if (copyText.length > 0) {
                await addToClipboard(copyText.join(''))
            }
        }
    });
}

// Detect Chromium-based browser. This is an unreliable hack.
// Chromium does not support 'browser' namespace/object and there is no chrome.runtime.getBrowserInfo() function
let isChromium = typeof browser === 'undefined';
let contexts = ['tab', 'page']; // Firefox can put menu item inside tab system menu

if (isChromium) {
    // Chrome does not support 'tab' context menu, — fallback to 'page':
    contexts = ['page'];
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: TABBARD_CONTEXT_MENU_ITEM_ID,
        enabled: true,
        type: 'normal',
        title: TABBARD_CONTEXT_MENU_ITEM_COPY_ALL,
        contexts: contexts
    });
});

if (!isChromium) {
    chrome.tabs.onHighlighted.addListener(function (highlightInfo) {
        if (highlightInfo.tabIds) {
            if (highlightInfo.tabIds.length > 1) {
                chrome.contextMenus.update(TABBARD_CONTEXT_MENU_ITEM_ID, {
                    title: TABBARD_CONTEXT_MENU_ITEM_COPY_SELECTED
                });
                chrome.action.setTitle({ title: TABBARD_CONTEXT_MENU_ITEM_COPY_SELECTED });
            } else {
                chrome.contextMenus.update(TABBARD_CONTEXT_MENU_ITEM_ID, {
                    title: TABBARD_CONTEXT_MENU_ITEM_COPY_ALL
                });
                chrome.action.setTitle({ title: TABBARD_CONTEXT_MENU_ITEM_COPY_ALL });
            }
        }
    });
}

// Solution 1 - As of Aug 2024, service workers cannot directly interact with
// the system clipboard using either `navigator.clipboard` or
// `document.execCommand()`. To work around this, we'll create an offscreen
// document and pass it the data we want to write to the clipboard.
async function addToClipboard(value) {
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Write text to the clipboard.'
    });
    chrome.runtime.sendMessage({
        type: 'copy-data-to-clipboard',
        target: 'offscreen-doc',
        data: value
    });
}

// Solution 2 – Once extension service workers can use the Clipboard API,
// replace the offscreen document based implementation with something like this.
// eslint-disable-next-line no-unused-vars -- This is an alternative implementation
async function addToClipboardV2(value) {
    navigator.clipboard.writeText(value);
}
