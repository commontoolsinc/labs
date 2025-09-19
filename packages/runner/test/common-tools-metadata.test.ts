import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { extractCommonToolsMetadata } from "../src/common-tools-metadata.ts";

describe("extractCommonToolsMetadata", () => {
  it("detects helpers and aliases from commontools alias references", () => {
    const source =
      "({ state }) => commontools_1.derive(state, (value) => value[commontools_1.NAME])";
    const metadata = extractCommonToolsMetadata(source);
    expect(metadata).toEqual({
      helpers: ["NAME", "derive"],
      aliases: ["commontools_1"],
    });
  });

  it("detects helpers from bare references", () => {
    const source = "({ charm }) => derive(charm, (value) => value[NAME])";
    const metadata = extractCommonToolsMetadata(source);
    expect(metadata).toEqual({
      helpers: ["NAME", "derive"],
      aliases: [],
    });
  });

  it("captures the base commontools alias", () => {
    const source = "(value) => commontools.navigateTo(value)";
    const metadata = extractCommonToolsMetadata(source);
    expect(metadata).toEqual({
      helpers: ["navigateTo"],
      aliases: ["commontools"],
    });
  });
});
