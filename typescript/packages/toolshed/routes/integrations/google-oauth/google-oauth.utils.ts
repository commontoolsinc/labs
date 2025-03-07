import { OAuth2Client } from "@cmd-johnson/oauth2-client";
import env from "@/env.ts";
import {
  type DocLink,
  getCellFromDocLink,
  getSpace,
  storage,
} from "@commontools/runner";
import { Context } from "@hono/hono";
import { Identity, Signer } from "@commontools/identity";
// Types
export interface AuthData {
  token?: string;
  tokenType?: string;
  scope?: string[];
  expiresIn?: number;
  refreshToken?: string;
  expiresAt?: number;
  user?: {
    email: string;
    name: string;
    picture: string;
  };
}

export interface OAuth2Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType: string;
  scope?: string[];
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
      scope:
        "email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
    },
  });
};

// Helper function to get the base URL
export const getBaseUrl = (url: string): string => {
  try {
    const parsedUrl = new URL(url);
    const origin = parsedUrl.origin;
    return origin.startsWith("http://localhost")
      ? origin
      : origin.replace("http://", "https://");
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
        ${
    result.success ? "Authentication Successful!" : "Authentication Failed"
  }
      </h1>
      <p>${
    result.success
      ? "You can close this window now."
      : result.error || "An error occurred"
  }</p>
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
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching user info:", error);
    return { error: "Failed to fetch user info" };
  }
}

let signer: Signer | undefined;

// Helper function to get auth cell and storage
export async function getAuthCellAndStorage(docLink: DocLink | string) {
  try {
    // Parse string to docLink if needed
    const parsedDocLink = typeof docLink === "string"
      ? JSON.parse(docLink)
      : docLink;

    if (!signer) {
      signer = await Identity.fromPassphrase("toolshed");
      storage.setSigner(signer);
    }

    storage.setRemoteStorage(new URL("http://localhost:8000"));

    // FIXME(ja): the space should be inferred from the doclink - but it isn't there yet
    // FIXME(ja): add the authcell schema!
    const authCell = getCellFromDocLink(
      getSpace(parsedDocLink.space),
      parsedDocLink,
      undefined,
    );

    // make sure the cell is live!
    await storage.syncCell(authCell, true);
    await storage.synced();

    return { authCell, storage };
  } catch (error) {
    throw new Error(`Failed to get auth cell: ${error}`);
  }
}

// Persist encrypted tokens to the auth cell
export async function persistTokens(
  oauthToken: OAuth2Tokens,
  userInfo: UserInfo,
  authCellDocLink: string | DocLink,
) {
  try {
    const { authCell, storage } = await getAuthCellAndStorage(authCellDocLink);

    if (!authCell) {
      throw new Error("Auth cell not found");
    }

    // Prepare token data to store
    const tokenData: AuthData = {
      token: oauthToken.accessToken,
      tokenType: oauthToken.tokenType,
      scope: oauthToken.scope,
      expiresIn: oauthToken.expiresIn,
      refreshToken: oauthToken.refreshToken,
      expiresAt: oauthToken.expiresIn
        ? Date.now() + oauthToken.expiresIn * 1000
        : undefined,
      user: {
        email: userInfo.email || "",
        name: userInfo.name || "",
        picture: userInfo.picture || "",
      },
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
    const tokenData = authCell.get() as AuthData | null;

    if (!tokenData) {
      throw new Error("No token data found in auth cell");
    }

    return tokenData;
  } catch (error) {
    throw new Error(`Error getting tokens: ${error}`);
  }
}

// Format token info for response
export function formatTokenInfo(tokenData: AuthData) {
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
export function createCallbackResponse(
  result: Record<string, unknown>,
): Response {
  return new Response(generateCallbackHtml(result), {
    headers: {
      "Content-Type": "text/html",
    },
  });
}

// Store code verifiers (could be moved to a more persistent storage in production)
export const codeVerifiers = new Map<string, string>();

// Type-safe response helpers for route handlers
export function createLoginSuccessResponse(c: any, url: string) {
  return c.json({ url }, 200) as any;
}

export function createLoginErrorResponse(c: any, errorMessage: string) {
  return c.json({ error: errorMessage }, 400) as any;
}

export function createRefreshSuccessResponse(
  c: any,
  message: string,
  tokenInfo: { expiresAt?: number; hasRefreshToken: boolean },
) {
  return c.json(
    {
      success: true,
      message,
      tokenInfo,
    },
    200,
  ) as any;
}

export function createRefreshErrorResponse(
  c: any,
  errorMessage: string,
  status = 400,
) {
  return c.json({ error: errorMessage }, status) as any;
}
