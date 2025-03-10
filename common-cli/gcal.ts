import { OAuth2Client } from "@cmd-johnson/oauth2-client";
import { load } from "@std/dotenv";
import { getAccessToken } from "./google.ts";

const env = await load({
  envPath: "./.env",
  // you can also specify multiple possible paths:
  // paths: [".env.local", ".env"]
  export: true, // this will export to process.env
});

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

const client = new OAuth2Client({
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  tokenUri: "https://oauth2.googleapis.com/token",
  authorizationEndpointUri: "https://accounts.google.com/o/oauth2/v2/auth",
  redirectUri: "http://localhost:8080",
  defaults: {
    scope: SCOPES.join(" "),
  },
});

export async function fetchCalendarEvents() {
  const accessToken = await getAccessToken(client);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  return await response.json();
}

// usage:
// const events = await fetchCalendarEvents();
// console.log(events);
