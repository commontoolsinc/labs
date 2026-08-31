import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  ciSubmissionsPrefix,
  localSubmissionsPrefix,
  parsePersonalKeyFile,
  parseServiceAccountKey,
  storeBucket,
  storePrefix,
} from "./test-records-config.ts";

const KEY = {
  client_email: "test-records-gh-octocat@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("test-records-config", () => {
  describe("storeBucket()", () => {
    it("returns the environment override when set", () => {
      expect(storeBucket(() => "other-bucket")).toBe("other-bucket");
    });

    it("returns the infra default otherwise", () => {
      expect(storeBucket(() => undefined)).toBe("cf-ci-metadata");
    });
  });

  describe("storePrefix()", () => {
    it("returns the labs dataset prefix by default", () => {
      expect(storePrefix(() => undefined)).toBe("labs/test-records");
    });
  });

  describe("ciSubmissionsPrefix()", () => {
    it("returns the relay-owned submissions folder", () => {
      expect(ciSubmissionsPrefix(() => undefined)).toBe(
        "labs/test-records/submissions/ci",
      );
    });
  });

  describe("localSubmissionsPrefix()", () => {
    it("returns the person's own submissions folder", () => {
      expect(localSubmissionsPrefix("octocat", () => undefined)).toBe(
        "labs/test-records/submissions/local/octocat",
      );
    });
  });

  describe("parseServiceAccountKey()", () => {
    it("returns the key of an account that names no person", () => {
      // The compactor writes on its own behalf, so its account carries no
      // username to derive and its key file carries no field naming one.
      const parsed = parseServiceAccountKey(JSON.stringify({
        ...KEY,
        client_email: "test-records-compactor@proj.iam.gserviceaccount.com",
      }));
      expect(parsed?.client_email).toBe(
        "test-records-compactor@proj.iam.gserviceaccount.com",
      );
      expect(parsed?.private_key).toBe(KEY.private_key);
    });

    it("returns undefined for malformed JSON", () => {
      expect(parseServiceAccountKey("{nope")).toBeUndefined();
    });

    it("returns undefined for a key missing a field it signs with", () => {
      expect(parseServiceAccountKey(JSON.stringify({
        client_email: KEY.client_email,
        token_uri: KEY.token_uri,
      }))).toBeUndefined();
      expect(
        parseServiceAccountKey(JSON.stringify({ ...KEY, private_key: "" })),
      )
        .toBeUndefined();
      expect(
        parseServiceAccountKey(JSON.stringify({ ...KEY, client_email: "" })),
      )
        .toBeUndefined();
    });

    it("returns undefined for any token endpoint but Google's", () => {
      expect(parseServiceAccountKey(JSON.stringify({
        ...KEY,
        token_uri: "https://oauth2.example/token",
      }))).toBeUndefined();
    });
  });

  describe("parsePersonalKeyFile()", () => {
    it("returns the key with the username field it carries", () => {
      const parsed = parsePersonalKeyFile(
        JSON.stringify({ ...KEY, cf_username: "long-name-with-hash" }),
      );
      expect(parsed?.cf_username).toBe("long-name-with-hash");
    });

    it("returns the username parsed from the account email otherwise", () => {
      expect(parsePersonalKeyFile(JSON.stringify(KEY))?.cf_username).toBe(
        "octocat",
      );
    });

    it("returns undefined for a key with no derivable username", () => {
      const parsed = parsePersonalKeyFile(
        JSON.stringify({ ...KEY, client_email: "other@proj.example" }),
      );
      expect(parsed).toBeUndefined();
    });

    it("returns undefined for malformed JSON", () => {
      expect(parsePersonalKeyFile("{nope")).toBeUndefined();
    });

    it("returns undefined for any token endpoint but Google's", () => {
      expect(parsePersonalKeyFile(JSON.stringify({
        ...KEY,
        token_uri: "http://oauth2.googleapis.com/token",
      }))).toBeUndefined();
      expect(parsePersonalKeyFile(JSON.stringify({
        ...KEY,
        token_uri: "https://oauth2.example/token",
      }))).toBeUndefined();
    });
  });
});
