import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertWebhookCellLinkRefPayload } from "../src/sigil-types.ts";

describe("assertWebhookCellLinkRefPayload", () => {
  it("accepts an addressing payload with valid fields", () => {
    expect(() =>
      assertWebhookCellLinkRefPayload({
        id: "of:abc",
        space: "did:key:z6Mk",
        path: ["a", "b"],
        scope: "space",
        overwrite: "redirect",
      })
    ).not.toThrow();
  });

  it("accepts an empty payload (every field is optional)", () => {
    expect(() => assertWebhookCellLinkRefPayload({})).not.toThrow();
  });

  it("accepts every valid scope", () => {
    for (const scope of ["inherit", "space", "user", "session"]) {
      expect(() => assertWebhookCellLinkRefPayload({ scope })).not.toThrow();
    }
  });

  it("accepts both overwrite values", () => {
    for (const overwrite of ["redirect", "this"]) {
      expect(() => assertWebhookCellLinkRefPayload({ overwrite })).not
        .toThrow();
    }
  });

  it("rejects an unexpected field (e.g. a smuggled schema)", () => {
    expect(() => assertWebhookCellLinkRefPayload({ schema: "x" })).toThrow(
      "Unexpected cell-link field",
    );
  });

  it("rejects an invalid scope (unsound assertion otherwise)", () => {
    expect(() => assertWebhookCellLinkRefPayload({ scope: "bogus" })).toThrow(
      'Cell-link "scope"',
    );
  });

  it("rejects an invalid overwrite", () => {
    expect(() => assertWebhookCellLinkRefPayload({ overwrite: "nope" }))
      .toThrow(
        'Cell-link "overwrite"',
      );
  });

  it("rejects a non-array path", () => {
    expect(() => assertWebhookCellLinkRefPayload({ path: "a" })).toThrow(
      'Cell-link "path"',
    );
  });

  it("rejects a non-string id", () => {
    expect(() => assertWebhookCellLinkRefPayload({ id: ["x"] })).toThrow(
      'Cell-link "id"',
    );
  });
});
