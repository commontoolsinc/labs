import { deepStrictEqual } from "node:assert/strict";
import { parseMustaches } from "../stache.js";
import * as hole from "../hole.js";

describe("parseMustaches", () => {
  it("parses", () => {
    const xml = `Hello {{world}}!`;
    const result = parseMustaches(xml);
    deepStrictEqual(result, ["Hello ", hole.create("world"), "!"]);
  });

  it("does not parse staches with non-word characters in them", () => {
    const xml = `Hello {{ world }}!`;
    const result = parseMustaches(xml);
    deepStrictEqual(result, ["Hello {{ world }}!"]);
  });

  it("handles broken staches", () => {
    const xml = `Hello {{world}!`;
    const result = parseMustaches(xml);
    deepStrictEqual(result, ["Hello {{world}!"]);
  });

  it("handles broken staches 2", () => {
    const xml = `Hello {world}}!`;
    const result = parseMustaches(xml);
    deepStrictEqual(result, ["Hello {world}}!"]);
  });

  it("handles broken staches 3", () => {
    const xml = `Hello {{wor}ld}}!`;
    const result = parseMustaches(xml);
    deepStrictEqual(result, ["Hello {{wor}ld}}!"]);
  });

  it("handles broken staches 4", () => {
    const xml = `Hello {{wor}}ld}}!`;
    const result = parseMustaches(xml);
    deepStrictEqual(result, ["Hello ", hole.create("wor"), "ld}}!"]);
  });
});