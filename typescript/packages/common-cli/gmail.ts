import { OAuth2Client } from "jsr:@cmd-johnson/oauth2-client@^2.0.0";
import { serve } from "https://deno.land/std@0.216.0/http/server.ts";
import { open } from "https://deno.land/x/open@v0.0.6/index.ts";
import { getAccessToken } from "./google.ts";

import { load } from "https://deno.land/std@0.216.0/dotenv/mod.ts";
const env = await load({
  envPath: "./.env",
  // you can also specify multiple possible paths:
  // paths: [".env.local", ".env"]
  export: true, // this will export to process.env
});

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

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

export async function fetchInboxEmails() {
  const accessToken = await getAccessToken(client);

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  return await response.json();
}
