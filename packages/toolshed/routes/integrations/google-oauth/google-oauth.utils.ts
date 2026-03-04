/**
 * Google OAuth utilities.
 *
 * Most functionality is now provided by the shared oauth2-common module.
 * This file defines the Google-specific provider config and the backward-
 * compatible `tokenToAuthData` mapper (Google uses `token` field, not `accessToken`).
 */
import type { Tokens } from "@cmd-johnson/oauth2-client";
import env from "@/env.ts";
import { AuthSchema, type Mutable, type Schema } from "@commontools/runner";
import type {
  OAuth2ProviderConfig,
  OAuth2Tokens,
} from "../oauth2-common/oauth2-common.index.ts";

// Re-export shared types so existing imports from this file continue to work
export type {
  CallbackResult,
  OAuth2Tokens,
  UserInfo,
} from "../oauth2-common/oauth2-common.index.ts";

// Re-export shared utils for backward compatibility
export {
  createBackgroundIntegrationErrorResponse,
  createBackgroundIntegrationSuccessResponse,
  createCallbackResponse,
  createLoginErrorResponse,
  createLoginSuccessResponse,
  createLogoutErrorResponse,
  createLogoutSuccessResponse,
  createRefreshErrorResponse,
  createRefreshSuccessResponse,
  fetchUserInfo,
  getBaseUrl,
} from "../oauth2-common/oauth2-common.index.ts";

export type AuthData = Mutable<Schema<typeof AuthSchema>>;

// ---------------------------------------------------------------------------
// Google provider config
// ---------------------------------------------------------------------------

export const GoogleProviderConfig: OAuth2ProviderConfig = {
  name: "google",
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  authorizationEndpointUri: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUri: "https://oauth2.googleapis.com/token",
  userInfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
  defaultScopes:
    "email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
  extraAuthParams: {
    access_type: "offline",
    prompt: "consent",
  },
};

// ---------------------------------------------------------------------------
// Google-specific token mapper (backward compat: uses `token` not `accessToken`)
// ---------------------------------------------------------------------------

export function tokenToAuthData(
  token: Tokens | OAuth2Tokens,
): Record<string, unknown> {
  return {
    token: token.accessToken,
    tokenType: token.tokenType,
    scope: token.scope,
    expiresIn: token.expiresIn,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn
      ? Date.now() + token.expiresIn * 1000
      : undefined,
  };
}

// Empty auth data for Google's AuthSchema shape
export const EMPTY_GOOGLE_AUTH_DATA: AuthData = {
  token: "",
  tokenType: "",
  scope: [],
  expiresIn: 0,
  expiresAt: 0,
  refreshToken: "",
  user: { email: "", name: "", picture: "" },
};
