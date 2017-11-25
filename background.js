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

let copyText = [];

function start(tab) {
    copyText = [];
    chrome.windows.getAll({
        "populate": true,
        "windowTypes": ["normal"]
    }, getAllTabs);
}

function getAllTabs(windows) {
    chrome.storage.local.get(['dontCopyTitles'], function (items) {
        let dontCopyTitles = items ? items.dontCopyTitles : false;

        const numWindows = windows.length;
        for (let i = 0; i < numWindows; i++) {
            const win = windows[i];
            const numTabs = win.tabs.length;
            for (let j = 0; j < numTabs; j++) {
                const tab = win.tabs[j];
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

