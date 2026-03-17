import type { IMemorySpaceAddress, Labels } from "../storage/interface.ts";
import {
  normalizeConfidentialityLabel,
  normalizeIntegrityLabel,
} from "./label-algebra.ts";

type CfcEntityKeyAddress = {
  space: string;
  id: string;
  type: string;
};
type CfcEntityAddress = Pick<IMemorySpaceAddress, "space" | "id" | "type">;

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function activityWriteChangedFlag(activityWrite: unknown): boolean {
  if (
    activityWrite && typeof activityWrite === "object" &&
    "changed" in activityWrite
  ) {
    return Boolean((activityWrite as { changed?: unknown }).changed);
  }
  return true;
}

export function cfcEntityKey(address: CfcEntityKeyAddress): string {
  return `${address.space}\u0000${address.id}\u0000${address.type}`;
}

export function cfcLabelsAddress(
  address: CfcEntityAddress,
): IMemorySpaceAddress {
  return {
    space: address.space,
    id: address.id,
    type: address.type,
    path: ["cfc", "labels"],
  };
}

export function normalizePersistedLabels(
  value: unknown,
): Record<string, Labels> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const labelsByPath: Record<string, Labels> = {};
  for (const [path, rawLabel] of Object.entries(value)) {
    if (!path.startsWith("/")) {
      continue;
    }
    if (!rawLabel || typeof rawLabel !== "object" || Array.isArray(rawLabel)) {
      continue;
    }
    const classification = normalizeConfidentialityLabel(
      (rawLabel as { classification?: unknown }).classification,
    );
    const integrity = normalizeIntegrityLabel(
      (rawLabel as { integrity?: unknown }).integrity,
    );
    if (!classification && !integrity) {
      continue;
    }
    labelsByPath[path] = {
      ...(classification ? { classification } : {}),
      ...(integrity ? { integrity } : {}),
    };
  }
  return labelsByPath;
}
