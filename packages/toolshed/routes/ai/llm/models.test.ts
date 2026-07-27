import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import {
  DEFAULT_GENERATE_OBJECT_MODELS,
  DEFAULT_IFRAME_MODELS,
} from "@commonfabric/llm";

/**
 * Provider registration in `models.ts` runs at import time and is gated on API
 * keys, so it is inert under the normal test env — generateObject.test.ts
 * asserts MODELS is empty there, and that is the intended contract.
 *
 * Setting a key and importing the module in-process would register providers
 * into the shared module graph and break that assertion for whichever file
 * imports second, so registration is exercised in a subprocess instead. The
 * pollution is the cached module, not the environment variable, so restoring
 * the env afterwards would not be enough.
 *
 * The invariant that matters is the last test: the shared LLM defaults must
 * name a model that is actually registered. Nothing checked that before, so
 * renaming a model and missing a default would surface only at runtime.
 */
const TOOLSHED_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

let cached: Record<string, unknown> | undefined;

const registeredModelNames = async (): Promise<string[]> => {
  if (cached === undefined) {
    const probe = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(
      probe,
      `const mod = await import(${
        JSON.stringify(new URL("./models.ts", import.meta.url).href)
      });\n` +
        `console.log(JSON.stringify(Object.keys(mod.MODELS)));\n`,
    );
    try {
      const command = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-check",
          "-A",
          // Both flags need the `=` form: passed as separate argv entries,
          // Deno reads the value as the script path instead.
          `--config=${TOOLSHED_ROOT}deno.jsonc`,
          `--env-file=${TOOLSHED_ROOT}.env.test`,
          probe,
        ],
        env: {
          ENV: "test",
          // Any non-empty value registers the OpenAI provider; nothing here
          // reaches the network, since createOpenAI only builds a client.
          CFTS_AI_LLM_OPENAI_API_KEY: "test-key-not-used-for-network",
          // Keep the gateway discovery fetch disabled, as .env.test does.
          CFTS_AI_GATEWAY_URL: "",
          // Let coverage follow into the subprocess when CI is collecting it.
          ...(Deno.env.get("DENO_COVERAGE_DIR") !== undefined
            ? { DENO_COVERAGE_DIR: Deno.env.get("DENO_COVERAGE_DIR")! }
            : {}),
        },
        stdout: "piped",
        stderr: "null",
      });
      const { code, stdout } = await command.output();
      assertEquals(code, 0, "model registry probe should exit cleanly");
      const lines = new TextDecoder().decode(stdout).trim().split("\n");
      cached = { names: JSON.parse(lines[lines.length - 1]) as string[] };
    } finally {
      await Deno.remove(probe).catch(() => {});
    }
  }
  return cached.names as string[];
};

describe("llm model registry", () => {
  it("registers the codename-tiered gpt-5.6 family", async () => {
    const names = await registeredModelNames();
    for (
      const name of [
        "openai:gpt-5.6-sol",
        "openai:gpt-5.6-terra",
        "openai:gpt-5.6-luna",
      ]
    ) {
      assert(names.includes(name), `${name} should be registered`);
    }
  });

  it("exposes bare and -latest aliases for the gpt-5.6 family", async () => {
    const names = await registeredModelNames();
    for (
      const alias of [
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "openai:gpt-5.6-sol-latest",
      ]
    ) {
      assert(names.includes(alias), `${alias} should resolve`);
    }
  });

  it("no longer registers the retired gpt-5-mini names", async () => {
    const names = await registeredModelNames();
    for (
      const name of [
        "openai:gpt-5-mini",
        "gpt-5-mini",
        "openai:gpt-5-mini-thinking",
      ]
    ) {
      assert(!names.includes(name), `${name} should be gone`);
    }
  });

  it("resolves the shared LLM defaults to registered models", async () => {
    const names = await registeredModelNames();
    for (
      const defaultName of [
        DEFAULT_IFRAME_MODELS,
        DEFAULT_GENERATE_OBJECT_MODELS,
      ]
    ) {
      assert(
        names.includes(defaultName),
        `${defaultName} is used as a default but is not registered`,
      );
    }
  });
});
