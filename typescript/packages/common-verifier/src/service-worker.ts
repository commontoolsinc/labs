console.log('Hello, SW');

chrome.tabs.onActivated.addListener(async (info) => {
  console.log('Activation info:', info);
  const { url } = await chrome.tabs.get(info.tabId);
  console.log('Active tab:', url);

  let icon = '/icon-unverified-128.png';

  if (url?.startsWith('chrome://')) {
    icon = '/icon-verified-128.png';
  }

  await chrome.action.setIcon({ path: { '128': icon }, tabId: info.tabId });
});
