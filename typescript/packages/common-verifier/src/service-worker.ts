console.log('Hello, SW');

async function updateIcon(verified: boolean, tabId: number) {
  let icon = verified ?
    '/icon-verified-128.png' :
    '/icon-unverified-128.png';

  await chrome.action.setIcon({
    path: { '128': icon },
    tabId,
  });
}

async function verify(origin: string): Promise<boolean> {
  console.log(`Verifying origin: ${origin}`);
  let res = await fetch(`${origin}/api/v0/verify`, {
    mode: 'cors',
    cache: 'no-cache',
    method: 'HEAD',
  });

  return !!res.ok;
  /*
  if (res.ok) {
    let json = await res.json();
    console.log(`JSON from verification service: ${JSON.stringify(json)}`);
    return json.success && json.success === true;
  }
  return false;
  */
}

chrome.tabs.onActivated.addListener(async (info) => {
  console.log('Activation info:', info);
  const { url } = await chrome.tabs.get(info.tabId);
  console.log('Active tab:', url);

  let verified = false;

  if (!url?.startsWith('chrome') &&
    url != undefined &&
    url.length > 0) {
    let origin = new URL(url).origin;
    try {
      verified = await verify(origin);
    } catch (e) {
      verified = false;
    }
  }

  console.log(`Updating icon -- verified status: ${verified}`);
  await updateIcon(verified, info.tabId);
});
