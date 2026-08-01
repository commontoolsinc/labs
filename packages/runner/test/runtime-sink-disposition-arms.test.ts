import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { ExecutionClaim } from "@commonfabric/memory/v2";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";
import type { ExternalSinkDispositionPolicy } from "../src/storage/interface.ts";

/**
 * THE TWO CONFIGURATIONS, AND THE ABSENCE OF A HYBRID.
 *
 * `serverPrimaryExecution` selects between exactly two postures, and this file
 * is the measurement that says so rather than the assertion that it is so:
 *
 *   OFF — the pre-arc behaviour precisely. No server execution, so the client
 *         does everything AND EGRESSES. The constructor default is
 *         "claim-conditional", `captureExecutionClaim` is not consulted at all
 *         (it is gated on the same flag), and the gate answers "allow".
 *   ON  — the server executes and the client is passive. The constructor
 *         default is "suppress", the gate answers "suppress", and `allow` is
 *         the exception a server-side executor earns by DECLARING
 *         "server-executor". THIS IS THE DEFAULT since 2026-08-01: the flag
 *         is absent-ON, and `false` is the deployment's rollback to the other
 *         posture.
 *
 * Why the halves must move together. The passivity half used to be
 * unconditional, which is the hybrid: with the flag OFF a client suppressed
 * every egress effect and no executor existed to perform it — a silently
 * missing side effect, which this arc rates strictly worse than a duplicated
 * one. `runner.ts`'s `addExecutionDemand` returns early unless the flag is on,
 * so under the flag-off arm there is provably nobody else to run the effect.
 *
 * WHAT IS ASSERTED IS THE DISPOSITION THE GATE RETURNS, not just the policy
 * the runtime resolved, and on top of that whether the sink was actually
 * RELEASED — the configured value and the answer are different surfaces
 * (`extended-storage-transaction.ts` maps one to the other through the
 * claim-observer stand-down), and only the release is the side effect.
 */

const CLAIM: ExecutionClaim = {
  branch: "",
  space: "did:key:zPlaceholder" as ExecutionClaim["space"],
  contextKey: "space",
  pieceId: "space:of:disposition-arms-piece",
  actionId: "action:disposition-arms",
  actionKind: "effect",
  implementationFingerprint: "impl:disposition-arms",
  runtimeFingerprint: "runtime:disposition-arms",
  leaseGeneration: 3,
  claimGeneration: 4,
  expiresAt: 100_000,
};

interface ArmResult {
  /** The policy the Runtime resolved for itself. */
  readonly resolved: ExternalSinkDispositionPolicy;
  /** The answer the gate returned for one effect attempt. */
  readonly gate: "allow" | "suppress";
  /** Recorded authority, i.e. which side the claim-conditional arm picked. */
  readonly authority: string | undefined;
  /** Whether the claim was captured — flag-off must not even look. */
  readonly capturedClaim: boolean;
  /** Post-commit sink releases: the actual outside-world action. */
  readonly releases: number;
}

/**
 * One arm, exercised end to end on its own Runtime and storage manager. The
 * flag propagates through a PROCESS-GLOBAL ambient (`memory/v2`'s
 * `setServerPrimaryExecutionConfig`), so arms are never run interleaved: each
 * builds, measures and disposes before the next constructs.
 */
const runArm = async (
  label: string,
  options: {
    readonly experimental?: { serverPrimaryExecution?: boolean };
    readonly declared?: ExternalSinkDispositionPolicy;
    /** Whether a server effect claim exists for this action. */
    readonly claimed?: boolean;
  },
): Promise<ArmResult> => {
  const signer = await Identity.fromPassphrase(`sink disposition arm ${label}`);
  const storage = StorageManager.emulate({ as: signer });
  const sourceAction = {};
  let capturedClaim = false;
  if (options.claimed) {
    storage.captureExecutionClaim = (action) => {
      if (action !== sourceAction) return undefined;
      capturedClaim = true;
      return { ...CLAIM, space: signer.did() };
    };
  }
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    ...(options.experimental ? { experimental: options.experimental } : {}),
    ...(options.declared !== undefined
      ? { externalSinkDisposition: options.declared }
      : {}),
  });

  try {
    let releases = 0;
    const tx = runtime.edit();
    tx.tx.sourceAction = sourceAction;
    const gate = tx.externalSinkDisposition();
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchText",
      `fetchText:${label}`,
      { url: `/${label}` },
      "fetchText-start",
      () => {
        releases++;
      },
    );
    assertEquals((await tx.commit()).error, undefined, `${label}: commit`);
    return {
      resolved: runtime.externalSinkDisposition,
      gate,
      authority: tx.tx.executionEffectAuthority,
      capturedClaim,
      releases,
    };
  } finally {
    await runtime.dispose();
    await storage.close();
  }
};

// THE MEASUREMENT. Read the two rows together: they are the same topology and
// differ only in the flag, so the difference between them IS what the flag
// buys — and the flag-off row is what the whole two-configuration split claims
// to preserve.
Deno.test("serverPrimaryExecution selects the sink disposition, and both arms are complete postures", async () => {
  // Flag OFF, explicitly. Today's behaviour: the client egresses.
  assertEquals(
    await runArm("flag-off", {
      experimental: { serverPrimaryExecution: false },
    }),
    {
      resolved: "claim-conditional",
      gate: "allow",
      authority: "client",
      capturedClaim: false,
      releases: 1,
    },
  );

  // Flag ABSENT is the DEFAULT CONFIGURATION, and since 2026-08-01 that is
  // the flag-ON one. Omission still selects a complete posture — the point
  // the unconditional default violated is that a runtime must never be
  // passive WITHOUT an executor, and the flag it now inherits is the same one
  // that gates `addExecutionDemand`, so the executor comes with it. The row
  // below is therefore identical to flag-on, and it is here to fail loudly if
  // the two ever diverge again.
  assertEquals(
    await runArm("flag-absent", {}),
    {
      resolved: "suppress",
      gate: "suppress",
      authority: undefined,
      capturedClaim: false,
      releases: 0,
    },
  );

  // Flag ON. The client is passive, full stop.
  assertEquals(
    await runArm("flag-on", {
      experimental: { serverPrimaryExecution: true },
    }),
    {
      resolved: "suppress",
      gate: "suppress",
      // Never consulted: the "suppress" branch returns before the
      // claim-observer stand-down records anything.
      authority: undefined,
      capturedClaim: false,
      releases: 0,
    },
  );
});

// The flag-off arm is CATEGORICALLY egressing, not conditionally so. A claim
// cannot make it stand down, because `captureExecutionClaim` is handed to the
// transaction only when the flag is on (`runtime.ts`) — which is what makes
// "flag off is today's behaviour" a statement about the whole surface rather
// than about the unclaimed subset of it. If this ever went "suppress", the
// effect would vanish: nothing publishes execution demand under the flag off.
Deno.test("with serverPrimaryExecution off, an available server claim is never even consulted", async () => {
  assertEquals(
    await runArm("flag-off-claimed", {
      experimental: { serverPrimaryExecution: false },
      claimed: true,
    }),
    {
      resolved: "claim-conditional",
      gate: "allow",
      authority: "client",
      capturedClaim: false,
      releases: 1,
    },
  );

  // Same claim, flag on: the claim IS consulted, and it is what makes the
  // claim-conditional posture stand down. Declared explicitly, because the
  // default under the flag is "suppress" and would answer before the claim
  // was reached — the stand-down is only observable in the declared posture.
  assertEquals(
    await runArm("flag-on-claimed", {
      experimental: { serverPrimaryExecution: true },
      declared: "claim-conditional",
      claimed: true,
    }),
    {
      resolved: "claim-conditional",
      gate: "suppress",
      authority: "server",
      capturedClaim: true,
      releases: 0,
    },
  );
});

// AN EXPLICIT DECLARATION BEATS THE DEFAULT IN BOTH ARMS. This is what keeps
// the ~37 harnesses that declare "server-executor" (and `executor-worker.ts`,
// the sole non-test site) unaffected by the gating: the executor egresses
// regardless of the flag, because it never rides the default at all.
Deno.test("a declared disposition overrides the flag in both configurations", async () => {
  for (const serverPrimaryExecution of [false, true]) {
    const flag = `spe-${serverPrimaryExecution}`;
    assertEquals(
      await runArm(`declared-server-executor-${flag}`, {
        experimental: { serverPrimaryExecution },
        declared: "server-executor",
      }),
      {
        resolved: "server-executor",
        gate: "allow",
        // The executor is the claim HOLDER, so the observer stand-down never
        // runs and nothing is recorded on the transaction.
        authority: undefined,
        capturedClaim: false,
        releases: 1,
      },
      `server-executor under ${flag}`,
    );

    assertEquals(
      await runArm(`declared-suppress-${flag}`, {
        experimental: { serverPrimaryExecution },
        declared: "suppress",
      }),
      {
        resolved: "suppress",
        gate: "suppress",
        authority: undefined,
        capturedClaim: false,
        releases: 0,
      },
      `suppress under ${flag}`,
    );
  }
});
