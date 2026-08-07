import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { DEFAULT_GENERATE_OBJECT_MODELS } from "@commonfabric/llm";

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
 * The invariant that matters is the last test: the shared LLM default must
 * name a model that is actually registered. Nothing checked that before, so
 * renaming a model and missing a default would surface only at runtime.
 */
const TOOLSHED_ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const REPO_ROOT = fromFileUrl(new URL("../../../../..", import.meta.url));

let cached: Record<string, unknown> | undefined;

const registeredModels = async (): Promise<{
  names: string[];
  providerOptions: Record<string, unknown>;
}> => {
  if (cached === undefined) {
    const probe = await Deno.makeTempFile({ suffix: ".ts" });
    // A dedicated result file rather than stdout: module registration logs
    // provider banners, so parsing stdout would couple the test to whatever
    // the providers happen to print.
    const resultPath = await Deno.makeTempFile({ suffix: ".json" });
    await Deno.writeTextFile(
      probe,
      `const mod = await import(${
        JSON.stringify(new URL("./models.ts", import.meta.url).href)
      });\n` +
        `const providerOptions = Object.fromEntries(\n` +
        `  Object.entries(mod.MODELS).flatMap(([name, config]) =>\n` +
        `    config.providerOptions !== undefined\n` +
        `      ? [[name, config.providerOptions]]\n` +
        `      : []\n` +
        `  ),\n` +
        `);\n` +
        `await Deno.writeTextFile(${
          JSON.stringify(resultPath)
        }, JSON.stringify({\n` +
        `  names: Object.keys(mod.MODELS),\n` +
        `  providerOptions,\n` +
        `}));\n`,
    );
    try {
      // Goes through the shared helper so the probe runs against a copied
      // lockfile and cannot mutate the workspace `deno.lock`.
      const output = await runDenoCommandWithTemporaryLock({
        root: REPO_ROOT,
        args: (lockPath) => [
          "run",
          "--no-check",
          "-A",
          `--lock=${lockPath}`,
          // Both flags need the `=` form: passed as separate argv entries,
          // Deno reads the value as the script path instead.
          `--config=${TOOLSHED_ROOT}deno.jsonc`,
          `--env-file=${TOOLSHED_ROOT}.env.test`,
          probe,
        ],
        env: {
          PATH: Deno.env.get("PATH") ?? "",
          HOME: Deno.env.get("HOME") ?? "",
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
      });
      assertEquals(
        output.code,
        0,
        `model registry probe should exit cleanly: ${
          new TextDecoder().decode(output.stderr)
        }`,
      );
      cached = JSON.parse(await Deno.readTextFile(resultPath)) as Record<
        string,
        unknown
      >;
    } finally {
      await Deno.remove(probe).catch(() => {});
      await Deno.remove(resultPath).catch(() => {});
    }
  }
  return cached as {
    names: string[];
    providerOptions: Record<string, unknown>;
  };
};

describe("llm model registry", () => {
  it("registers the codename-tiered gpt-5.6 family", async () => {
    const { names } = await registeredModels();
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
    const { names } = await registeredModels();
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
    const { names } = await registeredModels();
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

  it("resolves the shared generate-object default to a registered model", async () => {
    const { names } = await registeredModels();
    assert(
      names.includes(DEFAULT_GENERATE_OBJECT_MODELS),
      `${DEFAULT_GENERATE_OBJECT_MODELS} is used as a default but is not registered`,
    );
  });

  it("stores namespaced provider options on the registered models", async () => {
    const { providerOptions } = await registeredModels();
    // The un-namespaced `{ reasoningEffort }` shape was silently ignored by
    // the AI SDK; everything must live under a provider key.
    for (const [name, options] of Object.entries(providerOptions)) {
      for (const [key, value] of Object.entries(options as object)) {
        assert(
          typeof value === "object" && value !== null && !Array.isArray(value),
          `${name} providerOptions.${key} should be a provider namespace object`,
        );
      }
    }
    const openai = (providerOptions["openai:gpt-5.6-terra"] as {
      openai: Record<string, unknown>;
    }).openai;
    assertEquals(openai.store, false);
    assertEquals(openai.include, ["reasoning.encrypted_content"]);
    const thinking = (providerOptions["openai:gpt-5-thinking"] as {
      openai: Record<string, unknown>;
    }).openai;
    assertEquals(thinking.reasoningEffort, "high");
    assertEquals(thinking.store, false);
  });
});
