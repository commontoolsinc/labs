import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

type UiContractTrustRequirements = {
  trustedPattern?: string;
  requiredEventIntegrity?: readonly string[];
};

type UiActionContract = UiContractTrustRequirements & {
  helper: "UiAction";
  action: string;
};

type UiPromptSlotContract = UiContractTrustRequirements & {
  helper: "UiPromptSlot";
  surface: string;
  role?: string;
};

type UiDisclosureContract = UiContractTrustRequirements & {
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
    ui?: {
      pattern?: string;
      eventIntegrity?: unknown;
      uiContractDataset?: unknown;
    };
  };
};

type TrustedDomProvenance = {
  origin: "dom";
  trusted: true;
  ui?: {
    pattern?: unknown;
    eventIntegrity?: unknown;
    uiContractDataset?: unknown;
  };
};

const isTrustedDomProvenance = (
  provenance: unknown,
): provenance is TrustedDomProvenance =>
  isRecord(provenance) &&
  provenance.origin === "dom" &&
  provenance.trusted === true;

const trustRequirementsFromContract = (
  contract: Record<string, unknown>,
): UiContractTrustRequirements | undefined => {
  const trustedPattern = typeof contract.trustedPattern === "string"
    ? contract.trustedPattern
    : undefined;
  const requiredEventIntegrity = Array.isArray(contract.requiredEventIntegrity)
    ? contract.requiredEventIntegrity.filter((label): label is string =>
      typeof label === "string"
    )
    : undefined;

  return {
    ...(trustedPattern ? { trustedPattern } : {}),
    ...(requiredEventIntegrity && requiredEventIntegrity.length > 0
      ? { requiredEventIntegrity }
      : {}),
  };
};

export const uiContractFromSchema = (
  schema: JSONSchema | undefined,
): UiContract | undefined => {
  if (
    !isRecord(schema) || !isRecord(schema.ifc) ||
    !isRecord(schema.ifc.uiContract)
  ) {
    return undefined;
  }
  const contract = schema.ifc.uiContract;
  const trustRequirements = trustRequirementsFromContract(contract);
  switch (contract.helper) {
    case "UiAction":
      return typeof contract.action === "string"
        ? { helper: "UiAction", action: contract.action, ...trustRequirements }
        : undefined;
    case "UiPromptSlot":
      return typeof contract.surface === "string"
        ? {
          helper: "UiPromptSlot",
          surface: contract.surface,
          ...(typeof contract.role === "string" ? { role: contract.role } : {}),
          ...trustRequirements,
        }
        : undefined;
    case "UiDisclosure":
      return typeof contract.kind === "string"
        ? { helper: "UiDisclosure", kind: contract.kind, ...trustRequirements }
        : undefined;
    default:
      return undefined;
  }
};

export const trustedEventProvenanceMatchesUiContract = (
  provenance: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (contract === undefined || !isTrustedDomProvenance(provenance)) {
    return false;
  }
  if (
    contract.trustedPattern !== undefined ||
    (contract.requiredEventIntegrity?.length ?? 0) > 0
  ) {
    if (!isRecord(provenance.ui)) {
      return false;
    }
    if (
      contract.trustedPattern !== undefined &&
      provenance.ui.pattern !== contract.trustedPattern
    ) {
      return false;
    }
    if ((contract.requiredEventIntegrity?.length ?? 0) > 0) {
      const labels = provenance.ui.eventIntegrity;
      if (!Array.isArray(labels)) {
        return false;
      }
      const presentLabels = new Set(
        labels.filter((label): label is string => typeof label === "string"),
      );
      if (
        contract.requiredEventIntegrity?.some((label) =>
          !presentLabels.has(label)
        )
      ) {
        return false;
      }
    }
  }
  return true;
};

export const trustedEventMatchesUiContract = (
  event: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (contract === undefined || !isRecord(event)) {
    return false;
  }
  const serializedEvent = event as SerializedTrustedEvent;
  if (
    !trustedEventProvenanceMatchesUiContract(
      serializedEvent.provenance,
      contract,
    )
  ) {
    return false;
  }
  const dataset = serializedEvent.provenance?.ui?.uiContractDataset;
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
      eventId: `trusted-event:${
        String((event as { type?: string }).type ?? "event")
      }:${write.id}:${write.path.join("/")}`,
      provenance: (event as SerializedTrustedEvent).provenance,
    });
  }
};
