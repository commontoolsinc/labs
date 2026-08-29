import {
  moduleConnectors,
  type ModuleKind,
  type StationModule,
  type Vector3Tuple,
} from "./contract.ts";

export interface WritableBookmarkMap {
  key(moduleId: string): {
    set(value: boolean): Promise<void>;
  };
}

export interface PointerDragOwner {
  pointerId: number;
}

export function canBeginDrag(
  active: PointerDragOwner | undefined,
): boolean {
  return active === undefined;
}

export function ownsDrag<T extends PointerDragOwner>(
  active: T | undefined,
  pointerId: number,
): active is T {
  return active?.pointerId === pointerId;
}

const KIND_LABEL: Record<ModuleKind, string> = {
  hub: "Junction hub",
  habitat: "Habitat canister",
  cargo: "Cargo spine",
  solar: "Solar rig",
  relay: "Relay mast",
};

const KIND_COLOR: Record<ModuleKind, Vector3Tuple> = {
  hub: [0.28, 0.45, 0.57],
  habitat: [0.29, 0.56, 0.43],
  cargo: [0.69, 0.4, 0.18],
  solar: [0.32, 0.41, 0.72],
  relay: [0.57, 0.34, 0.64],
};

export function createSalvageModule(
  kind: ModuleKind,
  id: string,
): StationModule {
  const firstSeed = stableHash(id, 0x811c_9dc5);
  const secondSeed = stableHash(id, 0x9e37_79b9);
  const angle = firstSeed / 0x1_0000_0000 * Math.PI * 2;
  const radius = 8.5 + secondSeed / 0x1_0000_0000 * 4.2;
  return {
    id,
    label: `${KIND_LABEL[kind]} · ${stableModuleCode(id)}`,
    kind,
    color: [...KIND_COLOR[kind]],
    transform: {
      position: [
        Math.cos(angle) * radius,
        1.2,
        Math.sin(angle) * radius,
      ],
      rotationQuarterTurns: 0,
    },
    connectors: moduleConnectors(kind),
  };
}

export function isBookmarked(
  bookmarks: Readonly<Record<string, boolean>>,
  moduleId: string,
): boolean {
  return bookmarks[moduleId] === true;
}

export function setBookmark(
  bookmarks: WritableBookmarkMap,
  moduleId: string,
  value: boolean,
): Promise<void> {
  return bookmarks.key(moduleId).set(value);
}

function stableModuleCode(id: string): string {
  const hexadecimal = id.replaceAll("-", "");
  if (/^[0-9a-f]{32}$/i.test(hexadecimal)) {
    return BigInt(`0x${hexadecimal}`).toString(36).toUpperCase();
  }
  return id;
}

function stableHash(value: string, initial: number): number {
  let hash = initial;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
