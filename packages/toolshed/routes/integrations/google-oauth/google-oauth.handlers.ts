import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  BackgroundIntegrationRoute,
  CallbackRoute,
  LoginRoute,
  LogoutRoute,
  RefreshRoute,
} from "./google-oauth.routes.ts";
import {
  type CallbackResult,
  clearAuthData,
  createBackgroundIntegrationErrorResponse,
  createBackgroundIntegrationSuccessResponse,
  createCallbackResponse,
  createLoginErrorResponse,
  createLoginSuccessResponse,
  createLogoutErrorResponse,
  createLogoutSuccessResponse,
  createOAuthClient,
  createRefreshErrorResponse,
  createRefreshSuccessResponse,
  fetchUserInfo,
  getBaseUrl,
  persistTokens,
  tokenToAuthData,
} from "./google-oauth.utils.ts";
import { setBGCharm } from "@commontools/background-charm";
import { type CellLink, storage } from "@commontools/runner";
import { Tokens } from "@cmd-johnson/oauth2-client";

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

    const redirectUri = new URL(
      "/api/integrations/google-oauth/callback",
      getBaseUrl(c.req.url),
    ).toString();
    logger.debug({ redirectUri }, "Created redirect URI");

    // Create OAuth client
    const client = createOAuthClient(redirectUri);

    // Generate authorization URL with PKCE
    const { uri, codeVerifier } = await client.code.getAuthorizationUri();

    // Create state payload that includes the code verifier
    const statePayload = btoa(JSON.stringify({
      authCellId: payload.authCellId,
      integrationCharmId: payload.integrationCharmId,
      codeVerifier: codeVerifier,
    }));

    // Add state parameter and other required params to the URL
    const authUrl = new URL(uri.toString());
    authUrl.searchParams.set("state", statePayload);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

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
      const errorMsg = !code
        ? "No authorization code received"
        : "No state parameter received";
      logger.error(errorMsg);
      const callbackResult: CallbackResult = {
        success: false,
        error: errorMsg,
      };
      return createCallbackResponse(callbackResult);
    }

    // Decode and parse the state parameter
    let decodedState: {
      authCellId: string;
      integrationCharmId: string;
      codeVerifier: string;
    };

    try {
      decodedState = JSON.parse(atob(state));
      logger.info({
        decodedState: {
          authCellId: decodedState.authCellId,
          integrationCharmId: decodedState.integrationCharmId,
          codeVerifier: decodedState.codeVerifier ? "present" : "missing",
        },
      }, "Decoded state parameter");
    } catch (error) {
      logger.error({ state, error }, "Failed to decode state parameter");
      const callbackResult: CallbackResult = {
        success: false,
        error: "Invalid state parameter format",
      };
      return createCallbackResponse(callbackResult);
    }

    const codeVerifier = decodedState.codeVerifier;
    if (!codeVerifier) {
      logger.error("No code verifier found in state parameter");
      const callbackResult: CallbackResult = {
        success: false,
        error: "Invalid state parameter: missing code verifier",
      };
      return createCallbackResponse(callbackResult);
    }

    // Get the redirect URL for token exchange
    const baseUrl = getBaseUrl(c.req.url);
    const redirectUri = new URL(
      "/api/integrations/google-oauth/callback",
      baseUrl,
    ).toString();

    // Create OAuth client
    const client = createOAuthClient(redirectUri);

    // Exchange authorization code for tokens
    const tokens = await client.code.getToken(
      new URL(`?code=${code}`, redirectUri),
      {
        codeVerifier,
      },
    );

    logger.info(
      {
        accessTokenPrefix: tokens.accessToken.substring(0, 21) + "...",
        expiresAt: tokens.expiresIn
          ? Date.now() + tokens.expiresIn * 1000
          : undefined,
        hasRefreshToken: !!tokens.refreshToken,
      },
      "Received OAuth tokens",
    );

    // Fetch user info to verify the token
    const userInfo = await fetchUserInfo(tokens.accessToken);
    const authCellLink = JSON.parse(decodedState?.authCellId) as CellLink;

    // Save tokens to auth cell
    const tokenData = await persistTokens(tokens, userInfo, authCellLink);

    // Add this charm to the Gmail integration charms cell
    try {
      // Get the charm ID and space from the decodedState (which is the auth cell ID)
      const space = authCellLink.space;
      const integrationCharmId = decodedState?.integrationCharmId;

      if (space && integrationCharmId) {
        logger.info(
          { space, integrationCharmId },
          "Adding Google integration charm to Gmail integrations",
        );

        await setBGCharm({
          space,
          charmId: integrationCharmId,
          integration: "google",
          storage,
        });
      } else {
        logger.warn(
          { decodedState },
          "Could not extract space and charm ID from auth cell",
        );
      }
    } catch (error) {
      // Don't fail the main operation if this fails, just log it
      logger.error(
        { error },
        "Failed to add charm to Gmail integrations, continuing anyway",
      );
    }

    // Prepare and return the success response
    const callbackResult: CallbackResult = {
      success: true,
      message: "Authentication successful",
      details: {
        state: decodedState,
        scope,
        tokenInfo: tokenData,
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

  let refreshToken: string;

  try {
    const payload = await c.req.json();
    logger.info({ payload }, "Received Google OAuth refresh request");

    if (!payload.refreshToken) {
      logger.error("No refreshToken provided");
      return createRefreshErrorResponse(c, "No refreshToken provided");
    }

    refreshToken = payload.refreshToken;

    // Get redirect URI for client creation
    const baseUrl = getBaseUrl(c.req.url);
    const redirectUri = new URL(
      "/api/integrations/google-oauth/callback",
      baseUrl,
    ).toString();

    // Create OAuth client
    const client = createOAuthClient(redirectUri);

    let newToken: Tokens | undefined;
    try {
      newToken = await client.refreshToken.refresh(refreshToken);
    } catch (error) {
      logger.error({ error }, "Failed to refresh token");
      return createRefreshErrorResponse(c, "Failed to refresh token");
    }

    logger.info(
      {
        accessTokenPrefix: newToken.accessToken.substring(0, 21) + "...",
        expiresAt: newToken.expiresIn
          ? Date.now() + newToken.expiresIn * 1000
          : undefined,
        hasRefreshToken: !!newToken.refreshToken,
      },
      "Refreshed OAuth tokens",
    );

    const authData = tokenToAuthData(newToken);
    // Keep existing refresh token if a new one wasn't provided
    if (!authData.refreshToken) {
      authData.refreshToken = refreshToken;
    }

    return createRefreshSuccessResponse(c, "success", authData);
  } catch (error) {
    logger.error({ error }, "Failed to process refresh request");
    return createRefreshErrorResponse(c, "Failed to process refresh request");
  }
};

/**
 * Google OAuth Logout Handler
 * Clears authentication data from the auth cell
 */
export const logout: AppRouteHandler<LogoutRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info({ payload }, "Received Google OAuth logout request");

    if (!payload.authCellId) {
      logger.error({ payload }, "No authCellId provided in logout request");
      return createLogoutErrorResponse(c, "No authCellId provided");
    }

    try {
      // Clear auth data in the auth cell
      await clearAuthData(payload.authCellId);

      logger.info(
        { authCellId: payload.authCellId },
        "Successfully logged out",
      );

      // Return success response
      return createLogoutSuccessResponse(c, "Successfully logged out");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      logger.error(
        { error, authCellId: payload.authCellId },
        "Failed to clear auth data",
      );
      return createLogoutErrorResponse(
        c,
        `Failed to clear authentication data: ${errorMessage}`,
        500,
      );
    }
  } catch (error: unknown) {
    logger.error({ error }, "Failed to process logout request");
    return createLogoutErrorResponse(c, "Failed to process logout request");
  }
};

export const backgroundIntegration: AppRouteHandler<
  BackgroundIntegrationRoute
> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();

    await setBGCharm({
      space: payload.space,
      charmId: payload.charmId,
      integration: payload.integration,
      storage,
    });

    return createBackgroundIntegrationSuccessResponse(c, "success");
  } catch (error) {
    console.log("error", error);
    logger.error({ error }, "Failed to process background integration request");
    return createBackgroundIntegrationErrorResponse(
      c,
      "Failed to process background integration request",
    );
  }
};
