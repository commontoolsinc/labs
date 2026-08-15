// The toolshed process's ONE resolution of the server-execution v2 flag
// (docs/specs/server-side-execution/; docs/plans/server-execution-v2.md
// Phase 7): the environment's explicit `EXPERIMENTAL_SERVER_EXECUTION`
// value when set, else the first-party default. Both consumers in this
// process — the serving-host bootstrap (`server-execution.ts`) and the
// memory server's service-principal grant (`routes/storage/memory.ts`) —
// read THIS, so they can never disagree about the posture. Kept a leaf
// module (no runner executor imports) so the memory route can import it
// without pulling the serving loop.

import {
  type EnvReader,
  experimentalOptionsFromEnv,
} from "@commonfabric/runner";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

/** Whether THIS toolshed process runs the server-execution v2 posture:
 * the explicit env value if present (`"true"` / `"false"`), else
 * `SERVER_EXECUTION_DEFAULT_ENABLED`. */
export function serverExecutionEnabledFromEnv(envGet: EnvReader): boolean {
  return experimentalOptionsFromEnv(envGet).serverExecution ??
    SERVER_EXECUTION_DEFAULT_ENABLED;
}

/**
 * The memory-server service principals for this process (protocol.md §2b's
 * "read a foreign doc — free" row; serving-loop.md §3b's cross-space read
 * "under the piece's granted authority"): the operator-configured
 * `MEMORY_SERVICE_DIDS` list, PLUS — under the flag — this process's own
 * identity. The serving loop's per-space runtimes read foreign co-hosted
 * spaces (a served `#profile` wish reads the DEMANDING user's home space)
 * on the loopback plane as the process identity, and that plane's
 * sessions are admitted by the memory server's ordinary ACL. The
 * co-hosted SpaceServer is ALREADY the party the memory server trusts to
 * derive every space (its derived commits land through the engine-direct
 * sink; protocol.md §1's trust footing, FP2's read-row ruling), so under
 * the flag its identity is a service principal for the loopback plane's
 * reads too — the posture every deployment checklist already requires of
 * the operator DID (docs/plans/ingest-channels-journal-sink.md), made
 * automatic where the loop actually runs. OFF the flag: the configured
 * list verbatim (byte-identical). Foreign WRITES are NOT widened by this:
 * the wave's §2b accept gate checks the ACTING identity's structural
 * grant and deliberately ignores the service-DID blanket
 * (`foreignWriteAuthorityFor`).
 */
export function memoryServiceDidsFor(options: {
  configured: readonly string[];
  processIdentityDid: string;
  serverExecution: boolean;
}): readonly string[] {
  const dids = [...options.configured];
  if (
    options.serverExecution && !dids.includes(options.processIdentityDid)
  ) {
    dids.push(options.processIdentityDid);
  }
  return dids;
}
