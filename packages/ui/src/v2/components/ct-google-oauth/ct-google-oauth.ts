import { CTOauth } from "../ct-oauth/ct-oauth.ts";
import type { OAuthData } from "../ct-oauth/ct-oauth.ts";

/**
 * Re-export OAuthData as AuthData for backward compatibility.
 */
export type AuthData = OAuthData;

/**
 * CTGoogleOauth - Google OAuth authentication component
 *
 * Thin wrapper around the generic ct-oauth component with Google-specific defaults.
 *
 * @element ct-google-oauth
 *
 * @attr {CellHandle<AuthData>} auth - Cell containing authentication data
 * @attr {string[]} scopes - Array of OAuth scopes to request
 *
 * @example
 * <ct-google-oauth .auth=${authCell} .scopes=${['email', 'profile']}></ct-google-oauth>
 */
export class CTGoogleOauth extends CTOauth {
  constructor() {
    super();
    this.provider = "google";
    this.providerLabel = "Google";
    this.brandColor = "#4285f4";
    this.loginEndpoint = "/api/integrations/google-oauth/login";
    this.tokenField = "token";
  }
}

globalThis.customElements.define("ct-google-oauth", CTGoogleOauth);
