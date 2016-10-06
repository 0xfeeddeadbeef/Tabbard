
var copyText = [];

function start(tab) {
    copyText = [];
    chrome.windows.getAll({
        "populate": true,
        "windowTypes": ["normal"]
    }, getAllTabs);
}

function getAllTabs(windows) {
    var numWindows = windows.length;
    for (var i = 0; i < numWindows; i++) {
        var win = windows[i];
        var numTabs = win.tabs.length;
        for (var j = 0; j < numTabs; j++) {
            var tab = win.tabs[j];
            copyText.push(tab.title + '\r\n' + tab.url + '\r\n\r\n');
        }
    }

    if (copyText) {
        if (copyText.length > 0) {
            copyTextToClipboard(copyText.join(''))
        }
    }
}

function copyTextToClipboard(text) {
    var copyFrom = document.createElement('textarea');
    copyFrom.textContent = text;
    var body = document.getElementsByTagName('body')[0];
    body.appendChild(copyFrom);
    copyFrom.select();
    document.execCommand('copy');
    body.removeChild(copyFrom);
}

chrome.browserAction.onClicked.addListener(start);
