/**
 * Deployed-topology posture gate for cf-harness's FABRIC SESSION
 * (server-execution v2 Phase 7's flip PR — the plan's own obligation, and
 * the P7 independent review's finding 8: cf-harness resolves the flag by
 * the presets, and no gate exercised that resolution ON).
 *
 * What it proves, against a real serving toolshed: the harness's OWN
 * production session path — `createHarnessFabricSessionFactory` (PKCS#8
 * identity from disk → `PiecesController.initialize` → deployed-client
 * posture adoption → the remoteClient preset) — resolves the flipped
 * first-party default ON with NOTHING declared in the environment, and the
 * session executes one genuine flow (compile + instantiate a pattern,
 * read a served result back). The explicit-env ON lanes never exercised
 * this unset-flag path; the flip changes exactly it.
 *
 * Runs only in the "Deployed Topology Posture Gates" CI job (deno.yml),
 * which sets API_URL; it is in `integration/`, which the package's `test`
 * task does not match, so the workspace Test job never runs it. Locally:
 *   API_URL=http://localhost:8000 deno test --allow-env --allow-net \
 *     --allow-read --allow-write --allow-ffi --allow-run \
 *     integration/fabric-session-posture-gate.test.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { createHarnessFabricSessionFactory } from "../src/fabric-session.ts";

const API_URL = Deno.env.get("API_URL");

const GATE_PATTERN = `import { pattern } from "commonfabric";
export default pattern(() => ({ status: "serving" }));
`;

describe(
  "cf-harness deployed-topology posture gate",
  { ignore: !API_URL },
  () => {
    it("the fabric session resolves the flipped default ON and serves one genuine flow", async () => {
      // The gate exercises the DEFAULT resolution (unset flag → server
      // adoption → the first-party constant). An inherited explicit value
      // would make it vacuously test the env path instead.
      expect(Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION")).toBe(undefined);

      // The server half of the posture, probed from the gate itself: the
      // lane's toolshed really serves (the default binary since the flip).
      const stats = await (await fetch(new URL("/api/health/stats", API_URL)))
        .json() as { servingLoop?: unknown };
      expect(stats.servingLoop != null).toBe(true);

      const { path } = await writeTempIdentity();
      const factory = createHarnessFabricSessionFactory({
        apiUrl: API_URL!,
        identityKeyPath: path,
        space: `cf-harness-posture-gate-${Date.now()}`,
      });
      const session = await factory();
      try {
        // The client half: the session's runtime resolved ON from the
        // deployment with nothing declared locally.
        expect(session.pieces.runtime.experimental.serverExecution).toBe(true);

        // One genuine flow through the session: compile + instantiate a
        // pattern and read its result back through the serving topology.
        const piece = await session.pieces.create(GATE_PATTERN);
        const statusCell = (await piece.result.getCell())
          .asSchema<{ status?: string }>()
          .key("status");
        await statusCell.pull();
        await waitForCellValue<string>(
          session.pieces.runtime,
          statusCell,
          (value) => value === "serving",
        );
      } finally {
        await session.pieces.dispose();
      }
    });
  },
);
