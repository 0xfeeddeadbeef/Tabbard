/*
Copyright (c) 2017 George Chakhidze

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

let copyText = [];

/**
 * Event handler for the extension tool bar icon.
 * @param {Object} tab - Unused. Currently focused tab.
 */
function start(tab) {
    copyText = [];
    chrome.storage.local.get(['copyOnlyCurrentWindow'], function (items) {
        let copyOnlyCurrentWindow = items ? items.copyOnlyCurrentWindow : false;
        if (copyOnlyCurrentWindow) {
            chrome.windows.getCurrent({
                'populate': true,
                'windowTypes': ['normal', 'popup']
            }, function (win) {
                getAllTabs([win]);
            })
        } else {
            chrome.windows.getAll({
                'populate': true,
                'windowTypes': ['normal', 'popup']
            }, getAllTabs);
        }
    });
}

/**
 * Event handler for the context menu item.
 * @param {Object} info - The information about the context menu item.
 * @param {Object} tab - The current tab.
 */
function startContextMenu(info, tab) {
    if (info.menuItemId === TABBARD_CONTEXT_MENU_ITEM_ID) {
        start(tab);
    }
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
function getAllTabs(windows) {
    chrome.storage.local.get(['dontCopyTitles'], function (items) {
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
                copyTextToClipboard(copyText.join(''))
            }
        }
    });
}

/**
 * Copies the specified text to the Clipboard.
 * @param {string} text - The text to copy to the Clipboard.
 */
function copyTextToClipboard(text) {
    const copyFrom = document.createElement('textarea');
    copyFrom.textContent = text;
    const body = document.getElementsByTagName('body')[0];
    body.appendChild(copyFrom);
    copyFrom.select();
    document.execCommand('copy');
    body.removeChild(copyFrom);
}


chrome.browserAction.onClicked.addListener(start);

// HACK: Detect Google Chrome. This is an unreliable hack. Watch out!
// Chrome does not support 'browser' namespace/object and there is no chrome.runtime.getBrowserInfo() function
let isChrome = typeof browser === 'undefined';
let contexts = ['tab']; // Firefox will put new item inside tab system menu

if (isChrome) {
    // Chrome does not support 'tab' context menu, — fallback to 'page' — better than nothing:
    contexts = ['page'];
}

chrome.contextMenus.create({
    id: TABBARD_CONTEXT_MENU_ITEM_ID,
    enabled: true,
    type: 'normal',
    title: 'Copy all tab URLs',
    contexts: contexts
});

chrome.contextMenus.onClicked.addListener(startContextMenu);
