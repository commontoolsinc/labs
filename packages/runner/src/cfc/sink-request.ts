import { deepEqual } from "@commonfabric/utils/deep-equal";
import type { FabricValue } from "@commonfabric/api";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { createFrozenRequestSnapshot } from "./request-snapshot.ts";
import type { CfcPrepareState, WritePolicyInput } from "./types.ts";

type SinkRequestPolicyInput = Extract<
  WritePolicyInput,
  { kind: "sink-request" }
>;
type SinkRequestPolicyState = {
  writePolicyInputs: readonly WritePolicyInput[];
  prepare?: CfcPrepareState;
};

const isSinkRequestPolicyInput = (
  input: WritePolicyInput,
): input is SinkRequestPolicyInput => input.kind === "sink-request";

const preparedSinkRequestInputs = (
  state: SinkRequestPolicyState,
): readonly WritePolicyInput[] =>
  state.prepare?.status === "prepared"
    ? state.prepare.input.writePolicyInputs
    : state.writePolicyInputs;

export function createSinkRequestPolicyInput(
  sink: string,
  effectId: string,
  request: FabricValue,
): SinkRequestPolicyInput {
  return {
    kind: "sink-request",
    effectId,
    sink,
    request: createFrozenRequestSnapshot(request),
  };
}

export function recordSinkRequestPolicyInput(
  tx: Pick<IExtendedStorageTransaction, "recordCfcWritePolicyInput">,
  sink: string,
  effectId: string,
  request: FabricValue,
): void {
  tx.recordCfcWritePolicyInput(
    createSinkRequestPolicyInput(sink, effectId, request),
  );
}

export function verifySinkRequestRelease(
  tx: { getCfcState(): SinkRequestPolicyState },
  sink: string,
  effectId: string,
  request: FabricValue,
  preparedInput?: SinkRequestPolicyInput,
): string | undefined {
  const state = tx.getCfcState();
  const match = state.prepare?.status === "prepared"
    ? preparedSinkRequestInputs(state).find((input) =>
      isSinkRequestPolicyInput(input) &&
      input.sink === sink &&
      input.effectId === effectId
    ) as SinkRequestPolicyInput | undefined
    : preparedInput?.sink === sink && preparedInput.effectId === effectId
    ? preparedInput
    : preparedSinkRequestInputs(state).find((input) =>
      isSinkRequestPolicyInput(input) &&
      input.sink === sink &&
      input.effectId === effectId
    ) as SinkRequestPolicyInput | undefined;

  if (match === undefined) {
    return `missing sink-request policy input for ${sink}`;
  }

  if (!deepEqual(match.request, request)) {
    return `sink-request policy input mismatch for ${sink}`;
  }

  return undefined;
}

export function enqueueSinkRequestPostCommitEffect(
  tx: Pick<
    IExtendedStorageTransaction,
    "enqueuePostCommitEffect" | "recordCfcWritePolicyInput"
  >,
  sink: string,
  effectId: string,
  request: FabricValue,
  kind: string,
  flush: (tx: IExtendedStorageTransaction) => void | Promise<void>,
): void {
  const policyInput = createSinkRequestPolicyInput(sink, effectId, request);
  tx.recordCfcWritePolicyInput(policyInput);
  tx.enqueuePostCommitEffect({
    id: effectId,
    idempotencyKey: effectId,
    kind,
    flush: async (committedTx) => {
      const reason = verifySinkRequestRelease(
        committedTx as { getCfcState(): SinkRequestPolicyState },
        sink,
        effectId,
        request,
        policyInput,
      );
      if (reason !== undefined) {
        // Fail closed: the effect is not sent. Surface the reject to the
        // transaction (CFC stats + diagnostics) rather than only console.warn,
        // so a systematically failing release check is observable (audit W3.23).
        const noteable = committedTx as {
          noteCfcSinkReleaseReject?: (
            info: { sink: string; effectId: string; detail: string },
          ) => void;
        };
        if (typeof noteable.noteCfcSinkReleaseReject === "function") {
          noteable.noteCfcSinkReleaseReject({ sink, effectId, detail: reason });
        } else {
          console.warn("[CFC sink-request]", {
            ruleId: "sink-request-release",
            sink,
            effectId,
            detail: reason,
          });
        }
        return;
      }
      await flush(committedTx as IExtendedStorageTransaction);
    },
  });
}
