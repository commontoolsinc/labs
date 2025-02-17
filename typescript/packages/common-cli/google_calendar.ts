import { OAuth2Client } from "jsr:@cmd-johnson/oauth2-client@^2.0.0";
import { serve } from "https://deno.land/std@0.216.0/http/server.ts";
import { open } from "https://deno.land/x/open@v0.0.6/index.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

const client = new OAuth2Client({
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  tokenUri: "https://oauth2.googleapis.com/token",
  authorizationEndpointUri: "https://accounts.google.com/o/oauth2/v2/auth",
  redirectUri: "http://localhost:8080",
  defaults: {
    scope: SCOPES.join(" ")
  }
});

async function getAccessToken() {
  let authCode: string | null = null;
  const controller = new AbortController();
  const server = serve(async (req) => {
    const url = new URL(req.url);
    if (url.searchParams.has('code')) {
      authCode = url.searchParams.get('code');
      controller.abort();
      return new Response("Authentication successful! You can close this window.");
    }
    return new Response("Waiting for authentication...");
  }, { port: 8080, signal: controller.signal });

  const { uri, codeVerifier } = await client.code.getAuthorizationUri();
  console.log("Opening browser for authentication...");
  await open(uri.toString());

  try {
    await server;
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }

  if (!authCode) {
    throw new Error("Failed to get authorization code");
  }

  const tokens = await client.code.getToken(new URL(`http://localhost:8080?code=${authCode}`), {
    codeVerifier,
  });

  return tokens.accessToken;
}

export async function fetchCalendarEvents() {
  const accessToken = await getAccessToken();

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return await response.json();
}
