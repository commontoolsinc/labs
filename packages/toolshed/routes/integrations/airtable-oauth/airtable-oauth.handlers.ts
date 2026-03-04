import { createOAuth2Handlers } from "../oauth2-common/oauth2-common.index.ts";
import { AirtableProviderConfig } from "./airtable-oauth.config.ts";

const handlers = createOAuth2Handlers(AirtableProviderConfig);

export const login = handlers.login;
export const callback = handlers.callback;
export const refresh = handlers.refresh;
export const logout = handlers.logout;
