import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Engine } from "../src/harness/index.ts";
import { extractCommonToolsMetadata } from "../src/common-tools-metadata.ts";
import type { IRuntime } from "../src/runtime.ts";

// Minimal stub for the runtime object; Engine only needs it to satisfy typing.
const runtimeStub = {} as unknown as IRuntime;

describe("Engine.getInvocation", () => {
  const commontoolsStub = {
    derive: <T, R>(value: T, mapper: (input: T) => R) => mapper(value),
    NAME: "name",
  };

  const engine = new Engine(runtimeStub);
  (engine as unknown as { internals: any }).internals = {
    compiler: undefined,
    runtime: undefined,
    isolate: undefined,
    runtimeExports: { commontools: commontoolsStub },
    exportsCallback: () => {},
  };

  it("evaluates callbacks that reference commontools aliases", () => {
    const source =
      "({ charm }) => commontools_1.derive(charm, (value) => value[commontools_1.NAME])";
    const metadata = extractCommonToolsMetadata(source);
    const fn = engine.getInvocation(source, metadata);
    const result = fn({ charm: { [commontoolsStub.NAME]: "Charm" } });
    expect(result).toEqual("Charm");
  });

  it("evaluates callbacks with bare helper usage without metadata", () => {
    const source = "({ charm }) => derive(charm, (value) => value[NAME])";
    const fn = engine.getInvocation(source);
    const result = fn({ charm: { [commontoolsStub.NAME]: "Bare" } });
    expect(result).toEqual("Bare");
  });
});
