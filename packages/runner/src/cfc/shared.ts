import type { IMemorySpaceAddress, Labels } from "../storage/interface.ts";

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
    const rawClassification = (rawLabel as { classification?: unknown })
      .classification;
    const classification = Array.isArray(rawClassification)
      ? rawClassification.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0
      )
      : [];
    const rawIntegrity = (rawLabel as { integrity?: unknown }).integrity;
    const integrity = Array.isArray(rawIntegrity)
      ? rawIntegrity.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0
      )
      : [];
    if (classification.length === 0 && integrity.length === 0) {
      continue;
    }
    labelsByPath[path] = {
      ...(classification.length > 0 ? { classification } : {}),
      ...(integrity.length > 0 ? { integrity } : {}),
    };
  }
  return labelsByPath;
}
