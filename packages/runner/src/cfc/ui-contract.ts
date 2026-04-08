import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

type UiActionContract = {
  helper: "UiAction";
  action: string;
};

type UiPromptSlotContract = {
  helper: "UiPromptSlot";
  surface: string;
  role?: string;
};

type UiDisclosureContract = {
  helper: "UiDisclosure";
  kind: string;
};

export type UiContract =
  | UiActionContract
  | UiPromptSlotContract
  | UiDisclosureContract;

type SerializedTrustedEvent = {
  type?: string;
  provenance?: {
    origin?: string;
    trusted?: boolean;
  };
  target?: {
    dataset?: Record<string, string>;
  };
};

const isTrustedDomProvenance = (
  provenance: unknown,
): provenance is { origin: "dom"; trusted: true } =>
  isRecord(provenance) &&
  provenance.origin === "dom" &&
  provenance.trusted === true;

export const uiContractFromSchema = (
  schema: JSONSchema | undefined,
): UiContract | undefined => {
  if (!isRecord(schema) || !isRecord(schema.ifc) || !isRecord(schema.ifc.uiContract)) {
    return undefined;
  }
  const contract = schema.ifc.uiContract;
  switch (contract.helper) {
    case "UiAction":
      return typeof contract.action === "string"
        ? { helper: "UiAction", action: contract.action }
        : undefined;
    case "UiPromptSlot":
      return typeof contract.surface === "string"
        ? {
          helper: "UiPromptSlot",
          surface: contract.surface,
          ...(typeof contract.role === "string" ? { role: contract.role } : {}),
        }
        : undefined;
    case "UiDisclosure":
      return typeof contract.kind === "string"
        ? { helper: "UiDisclosure", kind: contract.kind }
        : undefined;
    default:
      return undefined;
  }
};

export const trustedEventMatchesUiContract = (
  event: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (contract === undefined || !isRecord(event)) {
    return false;
  }
  const serializedEvent = event as SerializedTrustedEvent;
  if (!isTrustedDomProvenance(serializedEvent.provenance)) {
    return false;
  }
  const dataset = serializedEvent.target?.dataset;
  if (!isRecord(dataset)) {
    return false;
  }

  switch (contract.helper) {
    case "UiAction":
      return dataset.uiAction === contract.action;
    case "UiPromptSlot":
      return dataset.uiSurface === contract.surface &&
        (contract.role === undefined || dataset.uiRole === contract.role);
    case "UiDisclosure":
      return dataset.uiDisclosureKind === contract.kind;
  }
};

export const recordTrustedEventPolicyInputs = (
  tx: Pick<IExtendedStorageTransaction, "recordCfcWritePolicyInput">,
  writes: readonly NormalizedFullLink[],
  event: unknown,
): void => {
  for (const write of writes) {
    const contract = uiContractFromSchema(write.schema);
    if (!trustedEventMatchesUiContract(event, contract)) {
      continue;
    }
    tx.recordCfcWritePolicyInput({
      kind: "trusted-event",
      target: {
        space: write.space,
        id: write.id,
        type: write.type,
        path: [...write.path],
      },
      eventId:
        `trusted-event:${String((event as { type?: string }).type ?? "event")}:${write.id}:${write.path.join("/")}`,
      provenance: (event as SerializedTrustedEvent).provenance,
    });
  }
};
