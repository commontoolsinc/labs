/**
 * Google OAuth handlers.
 *
 * Delegates to the shared oauth2-common handler factory with Google-specific
 * config: provider endpoints, backward-compatible token mapper (`token` field
 * instead of `accessToken`), and Google's AuthSchema.
 */
import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  BackgroundIntegrationRoute,
  CallbackRoute,
  LoginRoute,
  LogoutRoute,
  RefreshRoute,
} from "./google-oauth.routes.ts";
import { AuthSchema } from "@commontools/runner";
import type { JSONSchema } from "@commontools/runner";
import { createOAuth2Handlers } from "../oauth2-common/oauth2-common.index.ts";
import {
  EMPTY_GOOGLE_AUTH_DATA,
  GoogleProviderConfig,
  tokenToAuthData,
} from "./google-oauth.utils.ts";

const handlers = createOAuth2Handlers(GoogleProviderConfig, {
  tokenMapper: tokenToAuthData,
  authSchema: AuthSchema as unknown as JSONSchema,
  emptyAuthData: EMPTY_GOOGLE_AUTH_DATA,
});

export const login: AppRouteHandler<LoginRoute> = handlers.login;
export const callback: AppRouteHandler<CallbackRoute> = handlers.callback;
export const refresh: AppRouteHandler<RefreshRoute> = handlers.refresh;
export const logout: AppRouteHandler<LogoutRoute> = handlers.logout;
export const backgroundIntegration: AppRouteHandler<
  BackgroundIntegrationRoute
> = handlers.backgroundIntegration;
