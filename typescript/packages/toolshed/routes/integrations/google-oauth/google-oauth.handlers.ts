import type { AppRouteHandler } from "@/lib/types.ts";
import type { LoginRoute, CallbackRoute, RefreshRoute } from "./google-oauth.routes.ts";
import {
  createOAuthClient,
  getBaseUrl,
  createCallbackResponse,
  createErrorResponse,
  createLoginSuccessResponse,
  createLoginErrorResponse,
  createRefreshSuccessResponse,
  createRefreshErrorResponse,
  fetchUserInfo,
  getTokensFromAuthCell,
  persistTokens,
  formatTokenInfo,
  codeVerifiers,
  type CallbackResult,
} from "./google-oauth.utils.ts";

/**
 * Google OAuth Login Handler
 * Generates an authorization URL for Google OAuth
 */
export const login: AppRouteHandler<LoginRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info({ payload }, "Received Google OAuth login request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return createLoginErrorResponse(c, "Missing authCellId in request");
    }

    // Encode the auth cell ID as state parameter
    const authIdParam = btoa(JSON.stringify(payload.authCellId));
    const redirectUri = `${getBaseUrl(c.req.url)}/api/integrations/google-oauth/callback`;

    logger.debug({ redirectUri }, "Created redirect URI");

    // Create OAuth client
    const client = createOAuthClient(redirectUri);

    // Generate authorization URL with PKCE
    const { uri, codeVerifier } = await client.code.getAuthorizationUri();

    // Add state parameter and other required params to the URL
    const authUrl = new URL(uri.toString());
    authUrl.searchParams.set("state", authIdParam);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    // Store the code verifier for later use in the callback
    codeVerifiers.set(authIdParam, codeVerifier);

    logger.info({ authUrl: authUrl.toString() }, "Generated OAuth URL");

    return createLoginSuccessResponse(c, authUrl.toString());
  } catch (error) {
    logger.error({ error }, "Failed to process login request");
    return createLoginErrorResponse(c, "Failed to process login request");
  }
};

/**
 * Google OAuth Callback Handler
 * Processes the callback from Google OAuth and exchanges code for tokens
 */
export const callback: AppRouteHandler<CallbackRoute> = async (c) => {
  const logger = c.get("logger");
  const query = c.req.query();

  logger.info({ query }, "Received Google OAuth callback");

  try {
    // Extract all the details from the query
    const { code, state, scope, error: oauthError } = query;

    // Handle OAuth errors
    if (oauthError) {
      logger.error({ oauthError }, "OAuth error received");
      const callbackResult: CallbackResult = {
        success: false,
        error: `Authentication failed: ${oauthError}`,
      };
      return createCallbackResponse(callbackResult);
    }

    // Validate required parameters
    if (!code || !state) {
      const errorMsg = !code ? "No authorization code received" : "No state parameter received";
      logger.error(errorMsg);
      const callbackResult: CallbackResult = {
        success: false,
        error: errorMsg,
      };
      return createCallbackResponse(callbackResult);
    }

    // Decode and parse the state parameter (contains the auth cell ID)
    let decodedState: string;
    try {
      decodedState = JSON.parse(atob(state));
      logger.info({ decodedState }, "Decoded state parameter");
    } catch (error) {
      logger.error({ state, error }, "Failed to decode state parameter");
      const callbackResult: CallbackResult = {
        success: false,
        error: "Invalid state parameter format",
      };
      return createCallbackResponse(callbackResult);
    }

    // Get the code verifier for this state
    const codeVerifier = codeVerifiers.get(state);
    if (!codeVerifier) {
      logger.error(state, "No code verifier found for state");
      const callbackResult: CallbackResult = {
        success: false,
        error: "Invalid state parameter",
      };
      return createCallbackResponse(callbackResult);
    }

    // Get the redirect URL for token exchange
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
        accessTokenPrefix: tokens.accessToken.substring(0, 21) + "...",
        expiresAt: tokens.expiresAt,
        hasRefreshToken: !!tokens.refreshToken,
      },
      "Received OAuth tokens",
    );

    // Save tokens to auth cell
    const tokenData = await persistTokens(tokens, decodedState);

    // Fetch user info to demonstrate token usage
    const userInfo = await fetchUserInfo(tokens.accessToken);

    // Prepare and return the success response
    const callbackResult: CallbackResult = {
      success: true,
      message: "Authentication successful",
      details: {
        state: decodedState,
        scope,
        tokenInfo: formatTokenInfo(tokenData),
        userInfo,
        timestamp: new Date().toISOString(),
      },
    };
    return createCallbackResponse(callbackResult);
  } catch (error) {
    logger.error(error, "Failed to process callback");
    const callbackResult: CallbackResult = {
      success: false,
      error: "Failed to process callback",
    };
    return createCallbackResponse(callbackResult);
  }
};

/**
 * Google OAuth Token Refresh Handler
 * Refreshes an expired access token using a refresh token
 */
export const refresh: AppRouteHandler<RefreshRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info({ payload }, "Received Google OAuth refresh request");

    if (!payload.authCellId) {
      logger.error("No authCellId provided in refresh request");
      return createRefreshErrorResponse(c, "No authCellId provided");
    }

    try {
      // Get current token data from auth cell
      const tokenData = await getTokensFromAuthCell(payload.authCellId);

      if (!tokenData.refreshToken) {
        logger.error("No refresh token found in auth cell");
        return createRefreshErrorResponse(c, "No refresh token found");
      }

      // Get redirect URI for client creation
      const baseUrl = getBaseUrl(c.req.url);
      const redirectUri = `${baseUrl}/api/integrations/google-oauth/callback`;

      // Create OAuth client
      const client = createOAuthClient(redirectUri);

      // Refresh the token
      const tokens = await client.refreshToken.refresh(tokenData.refreshToken);

      logger.info(
        {
          accessTokenPrefix: tokens.accessToken.substring(0, 21) + "...",
          expiresAt: tokens.expiresAt,
          hasRefreshToken: !!tokens.refreshToken,
        },
        "Refreshed OAuth tokens",
      );

      // Keep existing refresh token if a new one wasn't provided
      if (!tokens.refreshToken) {
        tokens.refreshToken = tokenData.refreshToken;
      }

      // Update tokens in auth cell
      const updatedTokenData = await persistTokens(tokens, payload.authCellId);

      // Return success response
      return createRefreshSuccessResponse(
        c,
        "Token refreshed successfully",
        formatTokenInfo(updatedTokenData),
      );
    } catch (error) {
      logger.error({ error }, "Failed to refresh token");
      return createRefreshErrorResponse(
        c,
        "Failed to refresh token. The refresh token may be invalid or expired.",
        401,
      );
    }
  } catch (error) {
    logger.error({ error }, "Failed to process refresh request");
    return createRefreshErrorResponse(c, "Failed to process refresh request");
  }
};
