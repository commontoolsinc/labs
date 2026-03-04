import type { JSONSchema } from "@commontools/runner";

/**
 * Configuration for an OAuth2 provider.
 * Each provider (Google, Airtable, etc.) supplies one of these.
 */
export interface OAuth2ProviderConfig {
  /** Short lowercase name: "google", "airtable" */
  name: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpointUri: string;
  tokenUri: string;
  /** Endpoint to fetch user profile after token exchange */
  userInfoEndpoint?: string;
  /** Map raw user info response to normalized shape */
  userInfoMapper?: (raw: Record<string, unknown>) => UserInfo;
  /** Space-separated default scopes */
  defaultScopes: string;
  /** Extra query params appended to the authorization URL (e.g. access_type, prompt) */
  extraAuthParams?: Record<string, string>;
  /**
   * How to authenticate on the token endpoint.
   * - "body" (default): client_id/secret in POST body
   * - "basic": HTTP Basic Authorization header
   */
  tokenAuthMethod?: "body" | "basic";
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
  name?: string;
  picture?: string;
  error?: string;
}

export interface CallbackResult extends Record<string, unknown> {
  success: boolean;
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Options for customizing the handler factory output.
 */
export interface OAuth2HandlerOptions {
  /** Custom function to map OAuth2Tokens to the auth cell data shape */
  tokenMapper?: (token: OAuth2Tokens) => Record<string, unknown>;
  /** JSON schema to apply when reading/writing the auth cell */
  authSchema?: JSONSchema;
  /** Empty data object used when clearing auth (logout) */
  emptyAuthData?: Record<string, unknown>;
}
