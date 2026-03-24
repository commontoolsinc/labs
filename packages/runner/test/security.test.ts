import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("SES security regressions", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("rejects top-level mutable state before evaluation", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "let leaked = 0;",
            "export default function next() {",
            "  leaked += 1;",
            "  return leaked;",
            "}",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compile(program)).rejects.toThrow(
      "Top-level mutable bindings are not allowed in SES mode",
    );
  });

  it("does not expose host globals inside module compartments", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export default function probe() {",
            "  const host = globalThis as Record<string, unknown>;",
            "  return {",
            '    hasProcess: typeof host.process !== "undefined",',
            '    hasFetch: typeof host.fetch !== "undefined",',
            "  };",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(main?.default()).toEqual({
      hasProcess: false,
      hasFetch: false,
    });
  });

  it("blocks dynamic import attempts during compile", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commontools";',
            "export default lift(async () => {",
            '  const mod = await import("./helper.ts");',
            "  return mod.value;",
            "});",
          ].join("\n"),
        },
        {
          name: "/helper.ts",
          contents: "export const value = 1;",
        },
      ],
    };

    await expect(engine.compile(program)).rejects.toThrow();
  });

  it("keeps the callback compartment narrower than module load", () => {
    const probe = engine.getInvocation(`
      function probe() {
        return {
          hasProcess: typeof process !== "undefined",
          hasFetch: typeof fetch !== "undefined",
          hasConsoleHook: typeof globalThis.RUNTIME_ENGINE_CONSOLE_HOOK !== "undefined",
        };
      }
    `) as () => {
      hasProcess: boolean;
      hasFetch: boolean;
      hasConsoleHook: boolean;
    };

    expect(probe()).toEqual({
      hasProcess: false,
      hasFetch: false,
      hasConsoleHook: false,
    });
  });
});
