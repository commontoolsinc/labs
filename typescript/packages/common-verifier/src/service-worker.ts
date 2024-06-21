console.log('Hello, SW');

const VERIFIER_URL = "http://127.0.0.1:30125/api/v0/verify";

async function updateIcon(verified: boolean, tabId: number) {
  let icon = verified ?
    '/icon-verified-128.png' :
    '/icon-unverified-128.png';

  await chrome.action.setIcon({
    path: { '128': icon },
    tabId,
  });
}

async function verify(hostname: string): Promise<boolean> {
  console.log(`Verifying origin: ${hostname}`);
  let res = await fetch(VERIFIER_URL, {
    mode: 'cors',
    cache: 'no-cache',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    method: 'POST',
    body: JSON.stringify({
      origin: hostname,
    }),
  });

  if (res.ok) {
    let json = await res.json();
    console.log(`JSON from verification service: ${JSON.stringify(json)}`);
    return json.success && json.success === true;
  }
  return false;
}

chrome.tabs.onActivated.addListener(async (info) => {
  console.log('Activation info:', info);
  const { url } = await chrome.tabs.get(info.tabId);
  console.log('Active tab:', url);

  let verified = false;

  if (!url?.startsWith('chrome') &&
    url != undefined &&
    url.length > 0) {
    let hostname = new URL(url).hostname;
    verified = await verify(hostname);
  }

  console.log(`Updating icon -- verified status: ${verified}`);
  await updateIcon(verified, info.tabId);
});
