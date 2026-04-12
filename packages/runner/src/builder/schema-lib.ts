import { toDeepFrozenSchema } from "@commonfabric/data-model/schema-utils";
import { cfcAtom } from "../cfc/atoms.ts";

const credentialSecretAtom = cfcAtom.resource("CredentialSecret");

// This is used by the various Google tokens created with tokenToAuthData
export const AuthSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      token: {
        type: "string",
        default: "",
        ifc: { classification: [credentialSecretAtom] },
      },
      tokenType: { type: "string", default: "" },
      scope: { type: "array", items: { type: "string" }, default: [] },
      expiresIn: { type: "number", default: 0 },
      expiresAt: { type: "number", default: 0 },
      refreshToken: {
        type: "string",
        default: "",
        ifc: { classification: [credentialSecretAtom] },
      },
      user: {
        type: "object",
        properties: {
          email: { type: "string", default: "" },
          name: { type: "string", default: "" },
          picture: { type: "string", default: "" },
        },
      },
    },
  },
  true,
);

// More general OAuth2 Token (used by Airtable and future OAuth2 providers)
export const OAuth2TokenSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      accessToken: {
        type: "string",
        default: "",
        ifc: { classification: [credentialSecretAtom] },
      },
      tokenType: { type: "string", default: "" },
      scope: { type: "array", items: { type: "string" }, default: [] },
      expiresIn: { type: "number", default: 0 },
      expiresAt: { type: "number", default: 0 },
      refreshToken: {
        type: "string",
        default: "",
        ifc: { classification: [credentialSecretAtom] },
      },
      user: {
        type: "object",
        properties: {
          email: { type: "string", default: "" },
          name: { type: "string", default: "" },
          picture: { type: "string", default: "" },
        },
      },
    },
    required: ["accessToken", "tokenType"],
  },
  true,
);

// Webhook confidential config: URL and bearer token written by toolshed
export const WebhookConfigSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      url: {
        type: "string",
        default: "",
        ifc: { classification: [credentialSecretAtom] },
      },
      secret: {
        type: "string",
        default: "",
        ifc: { classification: [credentialSecretAtom] },
      },
    },
    required: ["url", "secret"],
  },
  true,
);
