export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;
export type HarnessCredentialProviderId = typeof OPENAI_CODEX_PROVIDER_ID;

export interface OpenAICodexOAuthCredential {
  type: "oauth";
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

export type HarnessCredential = OpenAICodexOAuthCredential;

export interface HarnessCredentialStatus {
  providerId: HarnessCredentialProviderId;
  signedIn: boolean;
  expiresAt?: number;
  expired?: boolean;
}
