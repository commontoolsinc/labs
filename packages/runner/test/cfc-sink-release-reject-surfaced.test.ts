import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import {
  createSinkRequestPolicyInput,
  enqueueSinkRequestPostCommitEffect,
} from "../src/cfc/sink-request.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";

// Regression guard for sink-release reject observability (audit W3.23).
//
// A post-commit sink release that fails verification is fail-closed (the effect
// is skipped), but it was only console.warn'd — invisible to CFC stats and
// diagnostics. The reject must now be surfaced to the transaction so the runtime
// can count it. The effect is still not sent.
describe("CFC sink-release reject surfacing", () => {
  it("notes a release reject on the transaction and skips the send", async () => {
    const request = createFrozenRequestSnapshot({
      url: "https://example.com/release-reject",
    });

    let captured: PostCommitSideEffect | undefined;
    const enqueueTx = {
      enqueuePostCommitEffect: (e: PostCommitSideEffect) => {
        captured = e;
      },
      recordCfcWritePolicyInput: () => {},
    };

    let flushed = false;
    enqueueSinkRequestPostCommitEffect(
      enqueueTx,
      "fetchJson",
      "fetchJson:release-reject",
      request,
      "fetchJson-start",
      () => {
        flushed = true;
      },
    );
    expect(captured).toBeDefined();

    // Commit-time policy input carries a DIFFERENT request than the prepared
    // snapshot, so release verification fails.
    const noted: Array<{ sink: string; effectId: string; detail: string }> = [];
    const mismatchingInputs = [
      createSinkRequestPolicyInput(
        "fetchJson",
        "fetchJson:release-reject",
        createFrozenRequestSnapshot({ url: "https://evil.example.com" }),
      ),
    ];
    const committedTx = {
      getCfcState: () => ({
        writePolicyInputs: mismatchingInputs,
        prepare: {
          status: "prepared",
          digest: "x",
          input: { writePolicyInputs: mismatchingInputs },
        },
      }),
      noteCfcSinkReleaseReject: (
        info: { sink: string; effectId: string; detail: string },
      ) => {
        noted.push(info);
      },
    };

    await captured!.flush!(committedTx);

    expect(flushed).toBe(false); // fail-closed: send skipped
    expect(noted.length).toBe(1);
    expect(noted[0].sink).toBe("fetchJson");
    expect(noted[0].effectId).toBe("fetchJson:release-reject");
    expect(noted[0].detail).toContain("mismatch");
  });
});
