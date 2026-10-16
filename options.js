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

// Chrome before 148 only exposes `chrome.*`; its Manifest V3 methods return promises too.
if (!globalThis.browser) {
    globalThis.browser = chrome;
}

// Keep in sync with DEFAULT_OPTIONS in background.js.
const DEFAULT_OPTIONS = { dontCopyTitles: false, copyOnlyCurrentWindow: false };
const REPORT_URL = 'https://github.com/0xfeeddeadbeef/Tabbard/issues/new';
// Keeps the pre-filled issue URL well below the length that browsers and GitHub accept.
const MAX_REPORT_DETAILS_LENGTH = 4000;

const checkboxes = {
    dontCopyTitles: document.querySelector('#dontcopytitles'),
    copyOnlyCurrentWindow: document.querySelector('#copyonlycurrentwindow')
};

const problem = {
    section: document.querySelector('#problem'),
    summary: document.querySelector('#problem-summary'),
    report: document.querySelector('#problem-report'),
    dismiss: document.querySelector('#problem-dismiss'),
    details: document.querySelector('#problem-details')
};

/**
 * Shows the saved options and the last copy failure, then lets the user change them. The
 * checkboxes are enabled only after loading, so that the loaded values can't overwrite a
 * quick first click.
 * @returns {Promise<void>}
 */
async function restoreOptions() {
    const stored = await browser.storage.local.get({ ...DEFAULT_OPTIONS, lastError: null });

    for (const [key, checkbox] of Object.entries(checkboxes)) {
        checkbox.checked = Boolean(stored[key]);
        checkbox.addEventListener('change', () => {
            browser.storage.local.set({ [key]: checkbox.checked }).catch(console.error);
        });
        checkbox.disabled = false;
    }

    showProblem(stored.lastError);
    problem.dismiss.addEventListener('click', () => {
        // background.js reacts to the removal and clears the toolbar button badge.
        browser.storage.local.remove('lastError').catch(console.error);
    });

    // Stay current when another options page changes a setting or a copy fails meanwhile.
    browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }
        for (const [key, checkbox] of Object.entries(checkboxes)) {
            if (key in changes) {
                checkbox.checked = Boolean(changes[key].newValue ?? DEFAULT_OPTIONS[key]);
            }
        }
        if ('lastError' in changes) {
            showProblem(changes.lastError.newValue ?? null);
        }
    });
}

/**
 * Shows the recorded copy failure with a link to report it, or hides the section.
 * @param {object | null} lastError - Record saved by background.js.
 */
function showProblem(lastError) {
    problem.section.hidden = !lastError;
    if (!lastError) {
        return;
    }

    const time = new Date(lastError.time);
    const when = Number.isNaN(time.getTime()) ? 'Recently' : `On ${time.toLocaleString()}`;
    problem.summary.textContent = `${when}, Tabbard couldn't copy your tabs. Click the Tabbard toolbar button to try again. If copying keeps failing, please report it.`;

    const details = formatDetails(lastError);
    problem.details.textContent = details;
    problem.report.href = buildReportUrl(lastError, details);
}

/**
 * @param {object} lastError
 * @returns {string} Diagnostics as plain text.
 */
function formatDetails(lastError) {
    return [
        `Tabbard: ${lastError.extensionVersion}`,
        `Browser: ${lastError.browser}`,
        `OS: ${lastError.os}`,
        `Background: ${lastError.environment}`,
        `Time: ${lastError.time}`,
        '',
        String(lastError.message)
    ].join('\n');
}

/**
 * @param {object} lastError
 * @param {string} details
 * @returns {string} URL of a new GitHub issue, pre-filled with the diagnostics.
 */
function buildReportUrl(lastError, details) {
    const firstLine = String(lastError.message).split('\n')[0];
    const body = [
        '### What happened?',
        '',
        '<!-- For example: I clicked the Tabbard toolbar button and nothing was copied. -->',
        '',
        '### Details from Tabbard',
        '',
        '```text',
        details.slice(0, MAX_REPORT_DETAILS_LENGTH),
        '```'
    ].join('\n');

    const url = new URL(REPORT_URL);
    url.searchParams.set('title', `Copying failed: ${firstLine}`.slice(0, 120));
    url.searchParams.set('body', body);
    return url.href;
}

restoreOptions().catch(console.error);
