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

// const client = new OAuth2Client({
//   clientId: GOOGLE_CLIENT_ID,
//   clientSecret: GOOGLE_CLIENT_SECRET,
//   tokenUri: "https://oauth2.googleapis.com/token",
//   authorizationEndpointUri: "https://accounts.google.com/o/oauth2/v2/auth",
//   redirectUri: "http://localhost:8080",
//   defaults: {
//     scope: SCOPES.join(" "),
//   },
// });

/**
 * Refreshes an access token using the refresh token
 * @param refreshToken The refresh token to use
 * @returns An object containing the new access token and expiry information
 */
export async function refreshAccessToken(refreshToken: string) {
  const tokenEndpoint = "https://oauth2.googleapis.com/token";
  
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Failed to refresh token: ${errorData.error_description || errorData.error || response.statusText}`);
  }

  const tokenData = await response.json();
  console.log({ tokenData });
  return {
    accessToken: tokenData.access_token,
    expiresIn: tokenData.expires_in,
    tokenType: tokenData.token_type,
    scope: tokenData.scope?.split(" ") || SCOPES,
    expiresAt: Date.now() + (tokenData.expires_in * 1000),
  };
}

/**
 * Auth token interface
 */
export interface AuthToken {
  token: string;
  tokenType: string;
  scope: string[];
  expiresIn: number;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Ensures the access token is valid, refreshing it if necessary
 * @param auth The current auth token object
 * @param bufferTime Time in milliseconds before expiry to trigger a refresh (default: 5 minutes)
 * @returns Updated auth token object with refreshed token if needed
 */
export async function ensureValidToken(auth: AuthToken, bufferTime = 5 * 60 * 1000): Promise<AuthToken> {
  // Check if token is expired or about to expire
  const isTokenExpired = auth.expiresAt < Date.now() + bufferTime;
  
  // If token is valid, return the current auth
  if (!isTokenExpired) {
    return auth;
  }
  
  // If token is expired or about to expire, refresh it
  if (auth.refreshToken) {
    try {
      console.log("Access token expired or about to expire. Refreshing...");
      const newAuth = await refreshAccessToken(auth.refreshToken);
      
      // Update the auth object with new token info
      return {
        ...auth,
        token: newAuth.accessToken,
        expiresIn: newAuth.expiresIn,
        expiresAt: newAuth.expiresAt,
        tokenType: newAuth.tokenType,
        scope: newAuth.scope,
      };
    } catch (error: unknown) {
      console.error("Failed to refresh access token:", error instanceof Error ? error.message : String(error));
      // Continue with the existing token, it might still work
      return auth;
    }
  }
  
  // If no refresh token is available, return the current auth
  return auth;
}

export async function fetchInboxEmails(accessToken: string) {
  // const accessToken = await getAccessToken(client);

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=3",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  return await response.json();
}

/**
 * Fetches a single email's full details by ID
 * @param accessToken The OAuth access token
 * @param messageId The ID of the email to fetch
 * @returns The full email details including headers, body, etc.
 */
export async function fetchEmailDetails(accessToken: string, messageId: string) {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Failed to fetch email details: ${errorData.error?.message || response.statusText}`);
  }

  return await response.json();
}

/**
 * Decodes a base64 URL-safe string to text
 * @param base64String The base64 URL-safe encoded string
 * @returns Decoded text
 */
function decodeBase64UrlSafe(base64String: string): string {
  // Replace URL-safe characters back to regular base64
  const regularBase64 = base64String.replace(/-/g, '+').replace(/_/g, '/');
  
  // Decode the base64 string
  return new TextDecoder().decode(
    Uint8Array.from(atob(regularBase64), (c) => c.charCodeAt(0))
  );
}

/**
 * Extracts the plain text or HTML content from an email
 * @param emailData The full email data from the Gmail API
 * @returns An object with plainText and/or htmlContent if available
 */
export function extractEmailContent(emailData: any) {
  const result: { plainText?: string; htmlContent?: string; subject?: string; from?: string; to?: string; date?: string } = {};
  
  // Extract headers
  if (emailData.payload?.headers) {
    for (const header of emailData.payload.headers) {
      if (header.name.toLowerCase() === 'subject') {
        result.subject = header.value;
      } else if (header.name.toLowerCase() === 'from') {
        result.from = header.value;
      } else if (header.name.toLowerCase() === 'to') {
        result.to = header.value;
      } else if (header.name.toLowerCase() === 'date') {
        result.date = header.value;
      }
    }
  }

  // Function to process parts recursively
  function processParts(part: any) {
    // Check if this part has a body with data
    if (part.body?.data) {
      const content = decodeBase64UrlSafe(part.body.data);
      
      if (part.mimeType === 'text/plain') {
        result.plainText = content;
      } else if (part.mimeType === 'text/html') {
        result.htmlContent = content;
      }
    }
    
    // Process nested parts if they exist
    if (part.parts) {
      for (const subPart of part.parts) {
        processParts(subPart);
      }
    }
  }

  // Start processing from the payload
  if (emailData.payload) {
    processParts(emailData.payload);
  }

  return result;
}

/**
 * Fetches multiple emails with their full content
 * @param accessToken The OAuth access token
 * @param messageIds Array of message IDs to fetch
 * @returns Array of emails with their details and content
 */
export async function fetchEmailsWithContent(accessToken: string, messageIds: string[]) {
  const emails = [];
  
  for (const messageId of messageIds) {
    try {
      const emailData = await fetchEmailDetails(accessToken, messageId);
      const content = extractEmailContent(emailData);
      
      emails.push({
        id: messageId,
        threadId: emailData.threadId,
        labelIds: emailData.labelIds,
        snippet: emailData.snippet,
        ...content
      });
    } catch (error) {
      console.error(`Error fetching email ${messageId}:`, error instanceof Error ? error.message : String(error));
    }
  }
  
  return emails;
}
