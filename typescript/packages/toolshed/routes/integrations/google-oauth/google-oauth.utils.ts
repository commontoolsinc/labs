import { OAuth2Client } from "jsr:@cmd-johnson/oauth2-client@^2.0.0";
import env from "@/env.ts";
import { createStorage } from "@commontools/charm";
import { getCellFromDocLink, type DocLink } from "@commontools/runner";
import { Context } from "hono";

// Types
export interface TokenData {
  token: string;
  tokenType: string;
  scope: string;
  expiresIn: number;
  refreshToken: string;
  expiresAt: number;
}

export interface OAuth2Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
  expiresAt?: number;
}

export interface UserInfo {
  id?: string;
  email?: string;
  verified_email?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  error?: string;
}

export interface CallbackResult extends Record<string, unknown> {
  success: boolean;
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
}

// Create OAuth client with credentials from environment variables
export const createOAuthClient = (redirectUri: string) => {
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    tokenUri: "https://oauth2.googleapis.com/token",
    authorizationEndpointUri: "https://accounts.google.com/o/oauth2/v2/auth",
    redirectUri,
    defaults: {
      scope: "email profile https://www.googleapis.com/auth/gmail.readonly",
    },
  });
};

// Helper function to get the base URL
export const getBaseUrl = (url: string): string => {
  try {
    const parsedUrl = new URL(url);
    const origin = parsedUrl.origin;
    return origin.startsWith("http://localhost") ? origin : origin.replace("http://", "https://");
  } catch (error) {
    // Fallback for development/testing
    return "http://localhost:8000";
  }
};

// Helper function to generate HTML for the callback page
export function generateCallbackHtml(result: Record<string, unknown>): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>OAuth Callback</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          margin-top: 50px;
        }
        .success {
          color: green;
        }
        .error {
          color: red;
        }
      </style>
    </head>
    <body>
      <h1 class="${result.success ? "success" : "error"}">
        ${result.success ? "Authentication Successful!" : "Authentication Failed"}
      </h1>
      <p>${result.success ? "You can close this window now." : result.error || "An error occurred"}</p>
      <script>
        // Send message to opener and close window
        if (window.opener) {
          window.opener.postMessage({
            type: 'oauth-callback',
            result: ${JSON.stringify(result)}
          }, window.location.origin);
          
          // Close the window after a short delay
          setTimeout(() => window.close(), 2000);
        }
      </script>
    </body>
    </html>
  `;
}

// Helper function to fetch user info using the access token
export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching user info:", error);
    return { error: "Failed to fetch user info" };
  }
}

// Helper function to get auth cell and storage
export async function getAuthCellAndStorage(docLink: DocLink | string) {
  try {
    // Parse string to docLink if needed
    const parsedDocLink = typeof docLink === "string" ? JSON.parse(docLink) : docLink;

    const storage = createStorage({
      type: "remote",
      replica: "uh2",
      url: new URL("http://localhost:8000"),
    });

    // Load the auth cell
    await storage.syncCell(parsedDocLink.cell, true);
    const authCell = getCellFromDocLink(parsedDocLink);

    return { authCell, storage };
  } catch (error) {
    throw new Error(`Failed to get auth cell: ${error}`);
  }
}

// Persist encrypted tokens to the auth cell
export async function persistTokens(tokens: OAuth2Tokens, authCellDocLink: string | DocLink) {
  try {
    const { authCell, storage } = await getAuthCellAndStorage(authCellDocLink);

    if (!authCell) {
      throw new Error("Auth cell not found");
    }

    // Prepare token data to store
    const tokenData: TokenData = {
      token: tokens.accessToken,
      tokenType: tokens.tokenType,
      scope: tokens.scope,
      expiresIn: tokens.expiresIn,
      refreshToken: tokens.refreshToken || "",
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    };

    // Set the new tokens to the auth cell
    authCell.set(tokenData);

    // Ensure the cell is synced
    await storage.synced();

    return tokenData;
  } catch (error) {
    throw new Error(`Error persisting tokens: ${error}`);
  }
}

// Get tokens from the auth cell
export async function getTokensFromAuthCell(authCellDocLink: string | DocLink) {
  try {
    const { authCell } = await getAuthCellAndStorage(authCellDocLink);

    if (!authCell) {
      throw new Error("Auth cell not found");
    }

    // Get the token data
    const tokenData = authCell.get() as TokenData | null;

    if (!tokenData) {
      throw new Error("No token data found in auth cell");
    }

    return tokenData;
  } catch (error) {
    throw new Error(`Error getting tokens: ${error}`);
  }
}

// Format token info for response
export function formatTokenInfo(tokenData: TokenData) {
  return {
    expiresAt: tokenData.expiresAt,
    hasRefreshToken: !!tokenData.refreshToken,
  };
}

// Standard error response
export function createErrorResponse(c: Context, message: string, status = 400) {
  return c.json({
    success: false,
    error: message,
  });
}

// Create a callback response
export function createCallbackResponse(result: Record<string, unknown>): Response {
  return new Response(generateCallbackHtml(result), {
    headers: {
      "Content-Type": "text/html",
    },
  });
}

// Store code verifiers (could be moved to a more persistent storage in production)
export const codeVerifiers = new Map<string, string>();
