import type { AppRouteHandler } from "@/lib/types.ts";
import type { LoginRoute, CallbackRoute } from "./google-oauth.routes.ts";
import { OAuth2Client } from "jsr:@cmd-johnson/oauth2-client@^2.0.0";
import env from "@/env.ts";
import { CharmManager, compileRecipe, createStorage } from "@commontools/charm";
import { getEntityId, idle } from "@commontools/runner";

// Create OAuth client with credentials from environment variables
const createOAuthClient = (redirectUri: string) => {
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
const getBaseUrl = (url: string): string => {
  try {
    const parsedUrl = new URL(url);
    const origin = parsedUrl.origin;
    return origin.startsWith("http://localhost") ? origin : origin.replace("http://", "https://");
  } catch (error) {
    // Fallback for development/testing
    return "http://localhost:8000";
  }
};

// Store code verifiers temporarily (in a real app, use a more persistent storage)
const codeVerifiers = new Map<string, string>();

export const login: AppRouteHandler<LoginRoute> = async (c) => {
  const logger = c.get("logger");
  const payload = await c.req.json();

  logger.info({ payload }, "Received Google OAuth login request");
  console.log("Google OAuth login payload:", payload);

  try {
    // Get the base URL from the request
    const authIdParam = btoa(JSON.stringify(payload.authCellId));
    const redirectUri = `${getBaseUrl(c.req.url)}/api/integrations/google-oauth/callback`;

    console.log("REDIRECT URI", redirectUri);
    // Create OAuth client
    const client = createOAuthClient(redirectUri);

    // Generate authorization URL with state containing the authCellId
    const { uri, codeVerifier } = await client.code.getAuthorizationUri();

    console.log("URI", uri);

    // Add state parameter to the URL
    const authUrl = new URL(uri.toString());
    authUrl.searchParams.set("state", authIdParam);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    // Store the code verifier for later use in the callback
    codeVerifiers.set(authIdParam, codeVerifier);

    logger.info({ authUrl: authUrl.toString() }, "Generated OAuth URL");

    const response = {
      url: authUrl.toString(),
    };
    console.log("RESPONSE", response);

    return c.json(response);
  } catch (error) {
    logger.error({ error }, "Failed to process login request");
    return c.json({ error: "Failed to process login request" }, 400);
  }
};

export const callback: AppRouteHandler<CallbackRoute> = async (c) => {
  const logger = c.get("logger");
  const query = c.req.query();

  logger.info({ query }, "Received Google OAuth callback");
  console.log("Google OAuth callback details:", query);

  try {
    // Extract all the details from the query
    const { code, state, scope, error: oauthError } = query;

    // Prepare the result object that will be sent to the opener window
    let result: Record<string, unknown>;

    if (oauthError) {
      logger.error({ oauthError }, "OAuth error received");
      result = {
        success: false,
        error: `Authentication failed: ${oauthError}`,
      };

      // Return HTML that sends a message to the opener window and closes itself
      return new Response(generateCallbackHtml(result), {
        headers: {
          "Content-Type": "text/html",
        },
      });
    }

    if (!code || !state) {
      const errorMsg = !code ? "No authorization code received" : "No state parameter received";
      logger.error(errorMsg);
      result = {
        success: false,
        error: errorMsg,
      };

      // Return HTML that sends a message to the opener window and closes itself
      return new Response(generateCallbackHtml(result), {
        headers: {
          "Content-Type": "text/html",
        },
      });
    }

    // Decode the base64-encoded state parameter
    let decodedState: string;
    try {
      decodedState = atob(state);
      logger.info({ decodedState }, "Decoded state parameter");
      console.log("Decoded state:", decodedState);
    } catch (error) {
      logger.error({ state, error }, "Failed to decode state parameter");
      result = {
        success: false,
        error: "Invalid state parameter format",
      };
      return new Response(generateCallbackHtml(result), {
        headers: {
          "Content-Type": "text/html",
        },
      });
    }

    // Get the code verifier for this state
    const codeVerifier = codeVerifiers.get(state);
    if (!codeVerifier) {
      logger.error({ state }, "No code verifier found for state");
      result = {
        success: false,
        error: "Invalid state parameter",
      };

      // Return HTML that sends a message to the opener window and closes itself
      return new Response(generateCallbackHtml(result), {
        headers: {
          "Content-Type": "text/html",
        },
      });
    }

    // Get the base URL from the request
    const baseUrl = getBaseUrl(c.req.url);
    const redirectUri = `${baseUrl}/api/integrations/google-oauth/callback`;

    // Create OAuth client
    const client = createOAuthClient(redirectUri);

    // Exchange authorization code for tokens
    const tokens = await client.code.getToken(new URL(`${redirectUri}?code=${code}`), {
      codeVerifier,
    });

    // Clean up the code verifier
    codeVerifiers.delete(state);

    logger.info(
      {
        accessToken: tokens.accessToken.substring(0, 10) + "...",
        expiresAt: tokens.expiresAt,
        hasRefreshToken: !!tokens.refreshToken,
      },
      "Received OAuth tokens",
    );

    // In a real implementation, you would store these tokens securely
    // associated with the user or the authCellId

    await persistEncryptedAccessTokens(tokens);

    // Fetch user info to demonstrate token usage
    const userInfo = await fetchUserInfo(tokens.accessToken);

    result = {
      success: true,
      message: "Authentication successful",
      details: {
        state: decodedState, // Use the decoded state
        scope,
        tokenInfo: {
          accessTokenPrefix: tokens.accessToken.substring(0, 10) + "...",
          expiresAt: tokens.expiresAt,
          hasRefreshToken: !!tokens.refreshToken,
        },
        userInfo,
        timestamp: new Date().toISOString(),
      },
    };

    // Return HTML that sends a message to the opener window and closes itself
    return new Response(generateCallbackHtml(result), {
      headers: {
        "Content-Type": "text/html",
      },
    });
  } catch (error) {
    logger.error({ error }, "Failed to process callback");
    const result = {
      success: false,
      error: "Failed to process callback",
    };

    // Return HTML that sends a message to the opener window and closes itself
    return new Response(generateCallbackHtml(result), {
      headers: {
        "Content-Type": "text/html",
      },
    });
  }
};

async function persistEncryptedAccessTokens(tokens: OAuth2Tokens) {
  const storage = createStorage({
    type: "remote",
    replica: "not-so-secret",
    url: env.MEMORY_URL,
  });

  const cellId = { "/": "baedreie2kfcbfdrqqzmhyhr5dv7flc5gh54yxyytqizubeg3tl2v5y6ve4" };
  await storage.syncCell(cellId, true);
  const authCellEntity = {
    cell: cellId,
    path: ["argument", "auth"],
  };

  const authCell = getCellFromDocLink(authCellEntity);
  console.log("AUTH CELL", authCell.get());

  authCell.set({ token: "wat" });
  await storage.synced();
}

// Helper function to generate HTML for the callback page
function generateCallbackHtml(result: Record<string, unknown>): string {
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
async function fetchUserInfo(accessToken: string) {
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
