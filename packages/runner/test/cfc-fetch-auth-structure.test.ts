import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalizeFetchDataInputs } from "../src/builtins/fetch-request.ts";
import {
  fetchAuthorizationHeaderPlacementAllowed,
} from "../src/cfc/fetch-auth-structure.ts";

describe("CFC fetch auth structure", () => {
  const token = "Bearer secret-token";

  it("allows auth when the token appears only in the Authorization header", () => {
    const inputs = normalizeFetchDataInputs({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      options: {
        method: "POST",
        body: {
          raw: "payload",
        },
        headers: {
          Authorization: token,
          "X-Idempotency-Key": "idem-1",
        },
      },
    });

    expect(fetchAuthorizationHeaderPlacementAllowed(inputs, token)).toBe(true);
  });

  it("rejects auth when the token also appears in the query string", () => {
    const inputs = normalizeFetchDataInputs({
      url:
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/send?access_token=${
          encodeURIComponent(token)
        }`,
      options: {
        method: "POST",
        headers: {
          Authorization: token,
        },
      },
    });

    expect(fetchAuthorizationHeaderPlacementAllowed(inputs, token)).toBe(false);
  });

  it("rejects auth when the token also appears in the body", () => {
    const inputs = normalizeFetchDataInputs({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      options: {
        method: "POST",
        body: {
          token,
        },
        headers: {
          Authorization: token,
        },
      },
    });

    expect(fetchAuthorizationHeaderPlacementAllowed(inputs, token)).toBe(false);
  });

  it("rejects auth when the same token appears in another header or header is absent", () => {
    const duplicated = normalizeFetchDataInputs({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      options: {
        method: "POST",
        headers: {
          Authorization: token,
          "X-Debug-Token": token,
        },
      },
    });
    const missing = normalizeFetchDataInputs({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      options: {
        method: "POST",
      },
    });

    expect(fetchAuthorizationHeaderPlacementAllowed(duplicated, token)).toBe(
      false,
    );
    expect(fetchAuthorizationHeaderPlacementAllowed(missing, token)).toBe(
      false,
    );
  });
});
