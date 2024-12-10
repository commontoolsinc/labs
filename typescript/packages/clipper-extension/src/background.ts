import browser from "webextension-polyfill";

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: "clipToCollectathon",
    title: "Clip to Collectathon",
    contexts: ["selection", "link", "image", "video", "audio"]
  });
});

browser.contextMenus.onClicked.addListener((info, _tab) => {
  if (info.menuItemId === "clipToCollectathon") {
    let content: any = {
      pageUrl: info.pageUrl
    };

    if (info.selectionText) {
      content = {
        type: "text",
        pageUrl: info.pageUrl,
        selectedContent: {
          text: info.selectionText,
          html: info.selectionText // Basic HTML wrapping could be added here if needed
        }
      };
    } else if (info.linkUrl) {
      content = {
        type: "link",
        pageUrl: info.pageUrl,
        url: info.linkUrl
      };
    } else if (info.srcUrl) {
      content = {
        type: info.mediaType || "image",
        pageUrl: info.pageUrl,
        url: info.srcUrl
      };
    }

    browser.storage.local.set({ clipContent: content }).then(() => {
      console.log('saved content', content)
      browser.action.openPopup();
    });
  }
});

browser.runtime.onConnect.addListener(function(port) {
  if (port.name === "popup") {
    port.onDisconnect.addListener(function() {
      // Clear stored content when popup is closed
      browser.storage.local.remove('clipContent');
    });
  }
});
