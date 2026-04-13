import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CfcAddress } from "./types.ts";

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

type TrustedEventPolicyTx = Pick<
  IExtendedStorageTransaction,
  "getCfcState" | "recordCfcWritePolicyInput"
>;

type AddressLike = {
  space: string;
  id: string;
  type: string;
  path: readonly unknown[];
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

const pathsEqual = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean =>
  left.length === right.length &&
  left.every((segment, index) => String(segment) === String(right[index]));

const targetMatchesWrite = (
  target: CfcAddress,
  write: AddressLike,
): boolean =>
  target.space === write.space &&
  target.id === write.id &&
  target.type === write.type &&
  pathsEqual(target.path, write.path);

const schemaCandidatesForWrite = (
  tx: TrustedEventPolicyTx,
  write: NormalizedFullLink,
): JSONSchema[] => {
  const schemas: JSONSchema[] = [];
  if (write.schema !== undefined) {
    schemas.push(write.schema);
  }
  for (const input of tx.getCfcState().writePolicyInputs) {
    if (
      input.kind === "schema" &&
      input.schema !== undefined &&
      targetMatchesWrite(input.target, write)
    ) {
      schemas.push(input.schema);
    }
  }
  return schemas;
};

const trustedEventPolicyInputAlreadyRecorded = (
  tx: TrustedEventPolicyTx,
  target: CfcAddress,
  eventId: string,
): boolean =>
  tx.getCfcState().writePolicyInputs.some((input) =>
    input.kind === "trusted-event" &&
    input.eventId === eventId &&
    targetMatchesWrite(input.target, target)
  );

const trustedEventId = (
  event: unknown,
  write: NormalizedFullLink,
): string =>
  `trusted-event:${
    String((event as { type?: string }).type ?? "event")
  }:${write.id}:${write.path.join("/")}`;

export const recordTrustedEventPolicyInputs = (
  tx: TrustedEventPolicyTx,
  writes: readonly NormalizedFullLink[],
  event: unknown,
): void => {
  for (const write of writes) {
    for (const schema of schemaCandidatesForWrite(tx, write)) {
      const contract = uiContractFromSchema(schema);
      if (!trustedEventMatchesUiContract(event, contract)) {
        continue;
      }
      const target = {
        space: write.space,
        id: write.id,
        type: write.type,
        path: [...write.path],
      };
      const eventId = trustedEventId(event, write);
      if (trustedEventPolicyInputAlreadyRecorded(tx, target, eventId)) {
        break;
      }
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target,
        eventId,
        provenance: (event as SerializedTrustedEvent).provenance,
      });
      break;
    }
  }
};
