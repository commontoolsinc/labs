import { createOAuth2Routes } from "../oauth2-common/oauth2-common.index.ts";

const routes = createOAuth2Routes("airtable");

export const login = routes.login;
export const callback = routes.callback;
export const refresh = routes.refresh;
export const logout = routes.logout;

export type LoginRoute = typeof login;
export type CallbackRoute = typeof callback;
export type RefreshRoute = typeof refresh;
export type LogoutRoute = typeof logout;
