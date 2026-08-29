import {
  moduleConnectors,
  type ModuleKind,
  type ModuleSnapClaim,
  type StationModule,
  type Vector3Tuple,
} from "./contract.ts";
import { findConnections } from "./geometry.ts";

export interface WritableBookmarkMap {
  key(moduleId: string): {
    set(value: boolean): Promise<void>;
  };
}

export interface PointerDragOwner {
  pointerId: number;
  moved?: boolean;
}

export type DragDisposition = "ignore" | "restore" | "commit";

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

/** Decides whether a pointer ending restores or commits its owned preview. */
export function dragDisposition(
  active: PointerDragOwner | undefined,
  pointerId: number,
  cancelled: boolean,
): DragDisposition {
  if (!ownsDrag(active, pointerId)) return "ignore";
  return cancelled || !active.moved ? "restore" : "commit";
}

/** Surfaces graphics bootstrap failures before preserving the thrown cause. */
export function initializeGraphics<T>(
  create: () => T,
  onFailure: (cause: unknown) => void,
): T {
  try {
    return create();
  } catch (cause) {
    onFailure(cause);
    throw cause;
  }
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

/**
 * Resolves concurrent snap intents through a connector-shaped conflict domain.
 * A target lock has one deterministic winner, independent of array order.
 */
export function resolveSnapClaims(
  modules: readonly StationModule[],
  claims: Readonly<Record<string, ModuleSnapClaim | null>>,
  targets: Readonly<Record<string, string | null>>,
): StationModule[] {
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const validClaims = Object.entries(claims).flatMap(([moduleId, claim]) => {
    const moving = modulesById.get(moduleId);
    const target = claim && modulesById.get(claim.targetModuleId);
    if (
      !claim || !moving || !target || moving.id === target.id ||
      !moving.connectors.some((connector) =>
        connector.id === claim.movingConnectorId
      ) ||
      !target.connectors.some((connector) =>
        connector.id === claim.targetConnectorId
      ) ||
      targets[snapTargetKey(claim.targetModuleId, claim.targetConnectorId)] !==
        claim.id
    ) return [];
    return [{ moduleId, claim }];
  });
  const claimantIds = new Set(validClaims.map(({ moduleId }) => moduleId));
  const occupied = new Set(
    findConnections(modules.filter((module) => !claimantIds.has(module.id)))
      .flatMap((connection) => [
        connectorKey(connection.first.moduleId, connection.first.id),
        connectorKey(connection.second.moduleId, connection.second.id),
      ]),
  );
  const winners = new Map<string, ModuleSnapClaim>();
  validClaims.sort((left, right) => {
    const leftTarget = connectorKey(
      left.claim.targetModuleId,
      left.claim.targetConnectorId,
    );
    const rightTarget = connectorKey(
      right.claim.targetModuleId,
      right.claim.targetConnectorId,
    );
    return leftTarget.localeCompare(rightTarget) ||
      left.moduleId.localeCompare(right.moduleId);
  });
  for (const { moduleId, claim } of validClaims) {
    const targetKey = connectorKey(
      claim.targetModuleId,
      claim.targetConnectorId,
    );
    if (occupied.has(targetKey)) continue;
    occupied.add(targetKey);
    winners.set(moduleId, claim);
  }
  return modules.map((module) => {
    const winner = winners.get(module.id);
    if (!winner) return module;
    return {
      ...module,
      transform: {
        position: [...winner.transform.position],
        rotationQuarterTurns: winner.transform.rotationQuarterTurns,
      },
    };
  });
}

/** Returns the shared conflict-domain key for one target connector. */
export function snapTargetKey(
  moduleId: string,
  connectorId: string,
): string {
  return `${moduleId}::${connectorId}`;
}

function connectorKey(moduleId: string, connectorId: string): string {
  return `${moduleId}\u0000${connectorId}`;
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
