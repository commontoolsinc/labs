import {
  experimentalOptionsFromEnv,
  type RuntimeOptions,
  runtimePresets,
} from "../src/index.ts";

/**
 * Runtime options for integration clients of the externally started toolshed.
 * The integration process inherits the deployment flags, so its memory
 * handshake must advertise the same capabilities as the server under test.
 */
export function deploymentRuntimeOptions(
  apiUrl: URL,
  storageManager: RuntimeOptions["storageManager"],
): RuntimeOptions {
  return runtimePresets.remoteClient({
    apiUrl,
    storageManager,
    experimental: experimentalOptionsFromEnv(Deno.env.get),
  });
}
