import browser from "webextension-polyfill";

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: "clipToCollectathon",
    title: "Clip to Collectathon",
    contexts: ["selection", "link", "image", "video", "audio"]
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "clipToCollectathon") {
    let content: any = {};

    if (info.selectionText) {
      content.type = "text";
      content.text = info.selectionText;
    } else if (info.linkUrl) {
      content.type = "link";
      content.url = info.linkUrl;
    } else if (info.srcUrl) {
      content.type = info.mediaType || "image";
      content.url = info.srcUrl;
    }

    content.pageUrl = info.pageUrl;

    browser.storage.local.set({ clipContent: content }).then(() => {
      browser.action.openPopup();
    });
  }
});

browser.runtime.onConnect.addListener(function(port) {
  if (port.name === "popup") {
    port.onDisconnect.addListener(function() {
      browser.storage.local.remove('clipContent');
    });
  }
});
