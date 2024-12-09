declare global {
  namespace google.accounts.oauth2 {
    interface TokenClient {
      callback: (response: {
        access_token: string;
        expires_in: number;
        scope: string;
        token_type: string;
        error?: string;
      }) => void;
      requestAccessToken: (options?: { prompt?: string }) => void;
    }
  }
}

type GoogleToken = {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

const CLIENT_ID = (import.meta as any).env.VITE_GOOGLE_CLIENT_ID;
const API_KEY = (import.meta as any).env.VITE_GOOGLE_API_KEY;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'
];

export let tokenClient: google.accounts.oauth2.TokenClient;
let hasToken = false;
export function isGmailAuthenticated() {
  return hasToken;
}

export function getToken() {
  return gapi.client.getToken();
}


async function initializeGapiClient() {
  await new Promise((resolve) => gapi.load('client', resolve));
  await gapi.client.init({
    apiKey: API_KEY,
    discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest'],
  });
}

function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
    callback: '', // defined later
  });
}

function checkExistingToken() {
    const savedToken = localStorage.getItem('gmail_token');
    if (savedToken) {
        const token = JSON.parse(savedToken);
        gapi.client.setToken(token);
        hasToken = true;
    }
}

export function attemptAuth(cb?: (resp: GoogleToken) => void) {
  tokenClient.callback = async (resp: GoogleToken) => {
    if ((resp as any).error !== undefined) {
      throw resp;
    }
    localStorage.setItem('gmail_token', JSON.stringify(resp));
    hasToken = true;
    cb?.(resp);
  };

  if (gapi.client.getToken() === null) {
    tokenClient.requestAccessToken({ prompt: 'consent' });
  } else {
    tokenClient.requestAccessToken({ prompt: '' });
  }
}

async function listEmails() {
  try {
    const response = await gapi.client.gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
    });

    const messages = response.result.messages;
    if (!messages || messages.length === 0) {
      console.log('No messages found.');
      return;
    }

    // Get the full message details
    for (const message of messages) {
      const email = await gapi.client.gmail.users.messages.get({
        userId: 'me',
        id: message.id,
      });
      console.log(email.result.snippet);
    }
  } catch (err) {
    console.error(err);
  }
}

// Initialize the API
window.onload = async () => {
  gisLoaded();
  await initializeGapiClient();
  checkExistingToken();
};

// Add types for gapi
declare global {
  interface Window {
    gapi: any;
    google: any;
  }
  var gapi: any;
  var google: any;
}
