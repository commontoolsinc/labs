chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "clipToCollectathon",
    title: "Clip to Collectathon",
    contexts: ["selection", "link", "image", "video", "audio"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "clipToCollectathon") {
    let content = {};

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

    chrome.storage.local.set({ clipContent: content }, () => {
      chrome.action.openPopup();
    });
  }
});

chrome.runtime.onConnect.addListener(function(port) {
  if (port.name === "popup") {
    port.onDisconnect.addListener(function() {
      chrome.storage.local.remove('clipContent');
    });
  }
});
