import env from "@/env.ts";
import type { OAuth2ProviderConfig } from "../oauth2-common/oauth2-common.index.ts";

export const AirtableProviderConfig: OAuth2ProviderConfig = {
  name: "airtable",
  clientId: env.AIRTABLE_CLIENT_ID,
  clientSecret: env.AIRTABLE_CLIENT_SECRET,
  authorizationEndpointUri: "https://airtable.com/oauth2/v1/authorize",
  tokenUri: "https://airtable.com/oauth2/v1/token",
  userInfoEndpoint: "https://api.airtable.com/v0/meta/whoami",
  userInfoMapper: (raw) => ({
    id: raw.id as string,
    email: raw.email as string,
    name: (raw.email as string) || "",
  }),
  defaultScopes: "data.records:read schema.bases:read",
  tokenAuthMethod: "basic",
};
