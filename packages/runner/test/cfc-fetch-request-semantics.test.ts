import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalizeFetchDataInputs } from "../src/builtins/fetch-request.ts";
import {
  deriveCfcFetchRequestSemantics,
} from "../src/cfc/fetch-request-semantics.ts";
import { computeCfcIntentPayloadDigest } from "../src/cfc/intent-refinement.ts";

describe("CFC fetch request semantics", () => {
  it("normalizes fetch inputs by stringifying structured bodies", () => {
    const normalized = normalizeFetchDataInputs({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      mode: "json",
      options: {
        method: "POST",
        body: {
          raw: "base64url-rfc2822",
        },
        headers: {
          Authorization: "Bearer token",
        },
      },
    });

    expect(normalized).toEqual({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      mode: "json",
      options: {
        method: "POST",
        body: JSON.stringify({
          raw: "base64url-rfc2822",
        }),
        headers: {
          Authorization: "Bearer token",
        },
      },
    });
  });

  it("derives gmail-like request semantics with endpoint override", () => {
    const normalized = normalizeFetchDataInputs({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      options: {
        method: "POST",
        body: {
          raw: "base64url-rfc2822",
        },
        headers: {
          authorization: "Bearer token",
          "X-Idempotency-Key": "idem-123",
        },
      },
    });

    const semantics = deriveCfcFetchRequestSemantics(normalized, {
      endpoint: "gmail.messages.send",
    });

    expect(semantics).toEqual({
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      payloadDigest: computeCfcIntentPayloadDigest(
        JSON.stringify({
          raw: "base64url-rfc2822",
        }),
      ),
      idempotencyKey: "idem-123",
    });
  });

  it("defaults endpoint to method + pathname when no override is provided", () => {
    const normalized = normalizeFetchDataInputs({
      url: "https://api.example.com/v1/widgets/42",
      options: {
        method: "PATCH",
        body: "patched",
        headers: {
          "x-idempotency-key": "idem-42",
        },
      },
    });

    expect(deriveCfcFetchRequestSemantics(normalized)).toEqual({
      audience: "https://api.example.com",
      endpoint: "PATCH /v1/widgets/42",
      payloadDigest: computeCfcIntentPayloadDigest("patched"),
      idempotencyKey: "idem-42",
    });
  });

  it("returns undefined when url is absent", () => {
    expect(deriveCfcFetchRequestSemantics({})).toBeUndefined();
  });
});
