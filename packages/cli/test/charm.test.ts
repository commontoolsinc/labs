import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseCharmOptions, parseSpaceOptions } from "../commands/charm.ts";

const API_URL = "https://ct.dev";
const SPACE = "common-knowledge";
const CHARM = "abcdefghijklmnopqrstuvwxyz";
const ID = "~/.my.key";
const FULL_URL = `${API_URL}/${SPACE}/${CHARM}`;
const NO_CHARM_FULL_URL = `${API_URL}/${SPACE}`;

describe("cli charm parsing", () => {
  it("parseSpaceOptions() handles individual components and full url", () => {
    const expected = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    };
    expect(parseSpaceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    })).toMatchObject(expected);
    expect(parseSpaceOptions({
      url: FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
    expect(parseSpaceOptions({
      url: NO_CHARM_FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
  });
  it("parseSpaceOptions() throws on incomplete input", () => {
    expect(() =>
      parseSpaceOptions({
        url: FULL_URL,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
        space: SPACE,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
        identity: ID,
      })
    ).toThrow(/--space/);
    expect(() =>
      parseSpaceOptions({
        space: SPACE,
        identity: ID,
      })
    ).toThrow(/--api-url/);
    expect(() =>
      parseSpaceOptions({
        identity: ID,
      })
    ).toThrow();
    expect(() =>
      parseSpaceOptions({
        space: SPACE,
      })
    ).toThrow();
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
      })
    ).toThrow();
  });

  it("parseCharmOptions() handles individual components and full url", () => {
    const expected = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      charm: CHARM,
    };
    expect(parseCharmOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      charm: CHARM,
    })).toMatchObject(expected);
    expect(parseCharmOptions({
      url: FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
  });
  it("parseCharmOptions() throws on incomplete input", () => {
    expect(() =>
      parseCharmOptions({
        url: NO_CHARM_FULL_URL,
        identity: ID,
      })
    ).toThrow(/--charm/);
    expect(() =>
      parseCharmOptions({
        apiUrl: API_URL,
        space: SPACE,
        identity: ID,
      })
    ).toThrow(/--charm/);
    expect(() =>
      parseCharmOptions({
        url: FULL_URL,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseCharmOptions({
        apiUrl: API_URL,
        space: SPACE,
        charm: CHARM,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseCharmOptions({
        apiUrl: API_URL,
        identity: ID,
        charm: CHARM,
      })
    ).toThrow(/--space/);
    expect(() =>
      parseCharmOptions({
        space: SPACE,
        identity: ID,
        charm: CHARM,
      })
    ).toThrow(/--api-url/);
    expect(() =>
      parseCharmOptions({
        identity: ID,
        charm: CHARM,
      })
    ).toThrow();
    expect(() =>
      parseCharmOptions({
        space: SPACE,
        charm: CHARM,
      })
    ).toThrow();
    expect(() =>
      parseCharmOptions({
        apiUrl: API_URL,
        charm: CHARM,
      })
    ).toThrow();
    expect(() =>
      parseCharmOptions({
        url: FULL_URL,
        charm: CHARM,
      })
    ).toThrow();
  });
});
