import {
  type EnvReader,
  experimentalOptionsFromEnv,
  type RuntimeOptions,
  runtimePresets,
} from "@commonfabric/runner";
import type { env as ToolshedEnv } from "@/env.ts";

/**
 * Assemble this toolshed's `RuntimeOptions` (CT-1814), extracted pure from
 * the server startup path so the wiring decisions are unit-testable:
 * `apiUrl` is the storage/memory base (MEMORY_URL), while patterns fetch
 * against the public API base (API_URL) — the builder/env.ts fallback is a
 * hardcoded `localhost:<ports.toolshed>`, wrong for any non-default port.
 * EXPERIMENTAL_* flags come from the injected env reader via the canonical
 * mapping.
 */
export function toolshedRuntimeOptions(
  config: Pick<ToolshedEnv, "MEMORY_URL" | "API_URL">,
  storageManager: RuntimeOptions["storageManager"],
  envGet: EnvReader = Deno.env.get,
): RuntimeOptions {
  return runtimePresets.productionServer({
    apiUrl: new URL(config.MEMORY_URL),
    patternApiUrl: new URL(config.API_URL),
    storageManager,
    experimental: experimentalOptionsFromEnv(envGet),
  });
}
