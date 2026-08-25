import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  DEFAULT_GITHUB_COLLECTION_INTERVAL_MS,
  GITHUB_HOST_CONFIG_SCHEMA,
  parseGithubHostConfig,
} from "../src/config.ts";

describe("config", () => {
  describe("parseGithubHostConfig()", () => {
    it("returns defaults for an otherwise complete configuration", () => {
      expect(parseGithubHostConfig({
        schema: GITHUB_HOST_CONFIG_SCHEMA,
        account: "Hixie",
      }))
        .toEqual({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          collectionIntervalMs: DEFAULT_GITHUB_COLLECTION_INTERVAL_MS,
          graphqlEndpoint: "https://api.github.com/graphql",
        });
    });

    it("rejects an unknown field", () => {
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          surprise: true,
        })
      ).toThrow("unknown field: surprise");
    });

    it("rejects a non-HTTPS GraphQL endpoint", () => {
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          graphqlEndpoint: "http://api.github.test/graphql",
        })
      ).toThrow("must use HTTPS");
    });

    it("rejects line breaks in identity fields", () => {
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie\nother",
        })
      ).toThrow("account must not contain line breaks");
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          graphqlEndpoint: "https://api.github.com/\rgraphql",
        })
      ).toThrow("graphqlEndpoint must not contain line breaks");
    });
  });
});
