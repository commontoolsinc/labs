import * as assert from "node:assert";
import * as hole from "../hole.js";

describe("hole.markup()", () => {
  it("it wraps the key in curly braces", () => {
    const markup = hole.markup("key");
    assert.strictEqual(markup, "{{key}}");
  });

  it("throws if key is not alphanumeric", () => {
    assert.throws(() => hole.markup("bad key with spaces"));
  });
});

describe("hole.create()", () => {
  it("it creates a hole", () => {
    const keyHole = hole.create("key");
    assert.deepStrictEqual(keyHole, {
      type: "hole",
      name: "key",
    });
  });

  it("throws if key is not alphanumeric", () => {
    assert.throws(() => hole.create("bad key with spaces"));
  });
});

describe("hole.parse()", () => {
  it("parses", () => {
    const xml = `Hello {{world}}!`;
    const result = hole.parse(xml);
    assert.deepStrictEqual(result, ["Hello ", hole.create("world"), "!"]);
  });

  it("does not parse staches with non-word characters in them", () => {
    const xml = `Hello {{ world }}!`;
    const result = hole.parse(xml);
    assert.deepStrictEqual(result, ["Hello {{ world }}!"]);
  });

  it("handles broken staches", () => {
    const xml = `Hello {{world}!`;
    const result = hole.parse(xml);
    assert.deepStrictEqual(result, ["Hello {{world}!"]);
  });

  it("handles broken staches 2", () => {
    const xml = `Hello {world}}!`;
    const result = hole.parse(xml);
    assert.deepStrictEqual(result, ["Hello {world}}!"]);
  });

  it("handles broken staches 3", () => {
    const xml = `Hello {{wor}ld}}!`;
    const result = hole.parse(xml);
    assert.deepStrictEqual(result, ["Hello {{wor}ld}}!"]);
  });

  it("handles broken staches 4", () => {
    const xml = `Hello {{wor}}ld}}!`;
    const result = hole.parse(xml);
    assert.deepStrictEqual(result, ["Hello ", hole.create("wor"), "ld}}!"]);
  });
});
