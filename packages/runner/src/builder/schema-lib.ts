import { JSONSchema } from "./types.ts";

const ClassificationSecret = "secret";

// This is used by the various Google tokens created with tokenToAuthData
export const AuthSchema = {
  type: "object",
  properties: {
    token: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
    tokenType: { type: "string", default: "" },
    scope: { type: "array", items: { type: "string" }, default: [] },
    expiresIn: { type: "number", default: 0 },
    expiresAt: { type: "number", default: 0 },
    refreshToken: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
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
} as const satisfies JSONSchema;

// More general OAuth2 Token
export const OAuth2TokenSchema = {
  type: "object",
  properties: {
    accessToken: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
    tokenType: { type: "string", default: "" },
    scope: { type: "array", items: { type: "string" }, default: [] },
    expiresIn: { type: "number", default: 0 },
    refreshToken: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
  },
  required: ["accessToken", "tokenType"],
} as const satisfies JSONSchema;
