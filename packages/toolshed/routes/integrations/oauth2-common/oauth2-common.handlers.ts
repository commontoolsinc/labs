import type { Tokens } from "@cmd-johnson/oauth2-client";
import { getLogger } from "@commontools/utils/logger";
import { setBGCharm } from "@commontools/background-charm";
import { runtime } from "@/index.ts";
import { OAuth2TokenSchema } from "@commontools/runner";
import type { JSONSchema } from "@commontools/runner";
import type {
  CallbackResult,
  OAuth2HandlerOptions,
  OAuth2ProviderConfig,
  UserInfo,
} from "./oauth2-common.types.ts";
import {
  clearAuthData,
  createBackgroundIntegrationErrorResponse,
  createBackgroundIntegrationSuccessResponse,
  createCallbackResponse,
  createLoginErrorResponse,
  createLoginSuccessResponse,
  createLogoutErrorResponse,
  createLogoutSuccessResponse,
  createOAuth2Client,
  createRefreshErrorResponse,
  createRefreshSuccessResponse,
  fetchUserInfo,
  getBaseUrl,
  persistTokens,
  tokenToGenericAuthData,
} from "./oauth2-common.utils.ts";

const EMPTY_OAUTH2_DATA: Record<string, unknown> = {
  accessToken: "",
  tokenType: "",
  scope: [],
  expiresIn: 0,
  expiresAt: 0,
  refreshToken: "",
  user: { email: "", name: "", picture: "" },
};

/**
 * Create a set of OAuth2 route handlers for a given provider.
 *
 * Returns plain async handler functions (not Hono-typed AppRouteHandler).
 * The caller wires them to the appropriate route definitions.
 */
export function createOAuth2Handlers(
  config: OAuth2ProviderConfig,
  options: OAuth2HandlerOptions = {},
) {
  // deno-lint-ignore no-explicit-any
  const logger = getLogger(`${config.name}-oauth`) as any;
  const tokenMapper = options.tokenMapper ?? tokenToGenericAuthData;
  const authSchema: JSONSchema = options.authSchema ??
    (OAuth2TokenSchema as unknown as JSONSchema);
  const emptyAuthData = options.emptyAuthData ?? EMPTY_OAUTH2_DATA;

  // -----------------------------------------------------------------------
  // LOGIN
  // -----------------------------------------------------------------------
  async function login(c: any) {
    try {
      const payload = await c.req.json();
      logger.info({ payload }, `Received ${config.name} OAuth login request`);

      if (!payload.authCellId) {
        logger.error("Missing authCellId in request payload");
        return createLoginErrorResponse(c, "Missing authCellId in request");
      }

      const redirectUri = `${
        getBaseUrl(c.req.url)
      }/api/integrations/${config.name}-oauth/callback`;
      const client = createOAuth2Client(config, redirectUri, payload.scopes);
      const scopeString = payload.scopes ? payload.scopes.join(" ") : undefined;

      const { uri, codeVerifier } = await client.code.getAuthorizationUri({
        scope: scopeString,
      });

      const statePayload = btoa(JSON.stringify({
        authCellId: payload.authCellId,
        integrationPieceId: payload.integrationPieceId,
        codeVerifier,
        scopes: payload.scopes,
      }));

      const authUrl = new URL(uri.toString());
      authUrl.searchParams.set("state", statePayload);

      // Apply provider-specific extra params (e.g. access_type=offline)
      if (config.extraAuthParams) {
        for (const [key, value] of Object.entries(config.extraAuthParams)) {
          authUrl.searchParams.set(key, value);
        }
      }

      if (scopeString) {
        authUrl.searchParams.set("scope", scopeString);
      }

      logger.info({ authUrl: authUrl.toString() }, "Generated OAuth URL");
      return createLoginSuccessResponse(c, authUrl.toString());
    } catch (error) {
      logger.error({ error }, "Failed to process login request");
      return createLoginErrorResponse(c, "Failed to process login request");
    }
  }

  // -----------------------------------------------------------------------
  // CALLBACK
  // -----------------------------------------------------------------------
  async function callback(c: any) {
    const query = c.req.query();
    logger.info({ query }, `Received ${config.name} OAuth callback`);

    try {
      const { code, state, scope, error: oauthError } = query;

      if (oauthError) {
        logger.error({ oauthError }, "OAuth error received");
        return createCallbackResponse({
          success: false,
          error: `Authentication failed: ${oauthError}`,
        });
      }

      if (!code || !state) {
        const errorMsg = !code
          ? "No authorization code received"
          : "No state parameter received";
        return createCallbackResponse({ success: false, error: errorMsg });
      }

      let decodedState: {
        authCellId: string;
        integrationPieceId: string;
        codeVerifier: string;
        scopes?: string[];
      };

      try {
        decodedState = JSON.parse(atob(state));
      } catch (_error) {
        return createCallbackResponse({
          success: false,
          error: "Invalid state parameter format",
        });
      }

      const codeVerifier = decodedState.codeVerifier;
      if (!codeVerifier) {
        return createCallbackResponse({
          success: false,
          error: "Invalid state parameter: missing code verifier",
        });
      }

      const baseUrl = getBaseUrl(c.req.url);
      const redirectUri =
        `${baseUrl}/api/integrations/${config.name}-oauth/callback`;
      const client = createOAuth2Client(
        config,
        redirectUri,
        decodedState.scopes,
      );

      let tokens: Tokens;

      if (config.tokenAuthMethod === "basic") {
        // Some providers (e.g. Airtable) require Basic auth on the token endpoint
        const basicAuth = btoa(`${config.clientId}:${config.clientSecret}`);
        const tokenResponse = await fetch(config.tokenUri, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${basicAuth}`,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
        });
        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          logger.error(
            { status: tokenResponse.status, errText },
            "Token exchange failed",
          );
          return createCallbackResponse({
            success: false,
            error: "Token exchange failed",
          });
        }
        const tokenData = await tokenResponse.json();
        tokens = {
          accessToken: tokenData.access_token,
          tokenType: tokenData.token_type ?? "Bearer",
          scope: tokenData.scope?.split(" "),
          expiresIn: tokenData.expires_in,
          refreshToken: tokenData.refresh_token,
        } as Tokens;
      } else {
        tokens = await client.code.getToken(
          new URL(`${redirectUri}?code=${code}`),
          { codeVerifier },
        );
      }

      // Fetch user info if endpoint is configured
      let userInfo: UserInfo = {};
      if (config.userInfoEndpoint) {
        userInfo = await fetchUserInfo(
          tokens.accessToken,
          config.userInfoEndpoint,
          config.userInfoMapper,
        );
      }

      // Map tokens to the auth cell data shape
      const tokenData = tokenMapper(tokens);
      if (userInfo && !userInfo.error) {
        tokenData.user = {
          email: userInfo.email || "",
          name: userInfo.name || "",
          picture: userInfo.picture || "",
        };
      }

      await persistTokens(tokenData, decodedState.authCellId, authSchema);

      // Register for background updates
      try {
        const authCellLink = JSON.parse(decodedState.authCellId);
        const space = authCellLink.space;
        const integrationPieceId = decodedState?.integrationPieceId;

        if (space && integrationPieceId) {
          await setBGCharm({
            space,
            pieceId: integrationPieceId,
            integration: config.name,
            runtime,
          });
        }
      } catch (error) {
        logger.error(
          { error },
          "Failed to register piece for background updates, continuing anyway",
        );
      }

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
      return createCallbackResponse({
        success: false,
        error: "Failed to process callback",
      });
    }
  }

  // -----------------------------------------------------------------------
  // REFRESH
  // -----------------------------------------------------------------------
  async function refresh(c: any) {
    try {
      const payload = await c.req.json();
      if (!payload.refreshToken) {
        return createRefreshErrorResponse(c, "No refreshToken provided");
      }
      const refreshToken: string = payload.refreshToken;

      const baseUrl = getBaseUrl(c.req.url);
      const redirectUri =
        `${baseUrl}/api/integrations/${config.name}-oauth/callback`;

      let newTokenData: Record<string, unknown>;

      if (config.tokenAuthMethod === "basic") {
        const basicAuth = btoa(`${config.clientId}:${config.clientSecret}`);
        const tokenResponse = await fetch(config.tokenUri, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${basicAuth}`,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        });
        if (!tokenResponse.ok) {
          return createRefreshErrorResponse(c, "Failed to refresh token");
        }
        const raw = await tokenResponse.json();
        newTokenData = tokenMapper({
          accessToken: raw.access_token,
          tokenType: raw.token_type ?? "Bearer",
          scope: raw.scope?.split(" "),
          expiresIn: raw.expires_in,
          refreshToken: raw.refresh_token,
        });
      } else {
        const client = createOAuth2Client(config, redirectUri);
        let newToken: Tokens;
        try {
          newToken = await client.refreshToken.refresh(refreshToken);
        } catch (_error) {
          return createRefreshErrorResponse(c, "Failed to refresh token");
        }
        newTokenData = tokenMapper(newToken);
      }

      // Preserve existing refresh token if not returned
      if (!newTokenData.refreshToken) {
        newTokenData.refreshToken = refreshToken;
      }

      return createRefreshSuccessResponse(c, "success", newTokenData);
    } catch (_error) {
      return createRefreshErrorResponse(
        c,
        "Failed to process refresh request",
      );
    }
  }

  // -----------------------------------------------------------------------
  // LOGOUT
  // -----------------------------------------------------------------------
  async function logout(c: any) {
    try {
      const payload = await c.req.json();
      if (!payload.authCellId) {
        return createLogoutErrorResponse(c, "No authCellId provided", 400);
      }

      try {
        await clearAuthData(payload.authCellId, authSchema, emptyAuthData);
        return createLogoutSuccessResponse(c, "Successfully logged out");
      } catch (error: unknown) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        return createLogoutErrorResponse(
          c,
          `Failed to clear authentication data: ${errorMessage}`,
          500,
        );
      }
    } catch (_error: unknown) {
      return createLogoutErrorResponse(
        c,
        "Failed to process logout request",
        400,
      );
    }
  }

  // -----------------------------------------------------------------------
  // BACKGROUND INTEGRATION (shared, not provider-specific)
  // -----------------------------------------------------------------------
  async function backgroundIntegration(c: any) {
    try {
      const payload = await c.req.json();
      await setBGCharm({
        space: payload.space,
        pieceId: payload.pieceId,
        integration: payload.integration,
        runtime,
      });
      return createBackgroundIntegrationSuccessResponse(c, "success");
    } catch (_error) {
      return createBackgroundIntegrationErrorResponse(
        c,
        "Failed to process background integration request",
      );
    }
  }

  return { login, callback, refresh, logout, backgroundIntegration };
}

// Re-export response helpers and utils needed by provider-specific code
export {
  createLogoutErrorResponse,
  createLogoutSuccessResponse,
} from "./oauth2-common.utils.ts";
