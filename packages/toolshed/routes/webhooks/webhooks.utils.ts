import { getLogger } from "@commontools/utils/logger";
import { sha256 } from "@/lib/sha2.ts";
import { runtime } from "@/index.ts";

const logger = getLogger("webhooks.utils");

const WEBHOOK_ID_LENGTH = 20;
const WEBHOOK_SECRET_BYTES = 32;
const MAX_APPEND_ITEMS = 1000;

// Base62 alphabet for generating IDs and secrets
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface WebhookRegistration {
  id: string;
  name: string;
  cellLink: string;
  secretHash: string;
  createdBy: string;
  createdAt: string;
  enabled: boolean;
  mode: "replace" | "append";
  lastReceivedAt?: string;
  deliveryCount: number;
}

// In-memory index for O(1) ingress lookup
export interface WebhookIndexEntry {
  registration: WebhookRegistration;
  space: string;
}

const webhookIndex = new Map<string, WebhookIndexEntry>();

export function getWebhookIndex(): Map<string, WebhookIndexEntry> {
  return webhookIndex;
}

function randomBase62(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let result = "";
  for (const byte of bytes) {
    result += BASE62[byte % 62];
  }
  return result;
}

export function generateWebhookId(): string {
  return `wh_${randomBase62(WEBHOOK_ID_LENGTH)}`;
}

export function generateWebhookSecret(): {
  secret: string;
  hashPromise: Promise<string>;
} {
  const bytes = crypto.getRandomValues(new Uint8Array(WEBHOOK_SECRET_BYTES));
  // Encode as base62 with whsec_ prefix
  let encoded = "";
  for (const byte of bytes) {
    encoded += BASE62[byte % 62];
  }
  const secret = `whsec_${encoded}`;
  const hashPromise = sha256(secret);
  return { secret, hashPromise };
}

export async function verifyWebhookSecret(
  provided: string,
  storedHash: string,
): Promise<boolean> {
  const providedHash = await sha256(provided);

  // Timing-safe comparison
  const a = new TextEncoder().encode(providedHash);
  const b = new TextEncoder().encode(storedHash);
  if (a.length !== b.length) return false;

  // Use constant-time comparison
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// Well-known entity ID for webhook registry (hash of "ct:webhooks-registry")
let registryEntityId: string | null = null;

async function getRegistryEntityId(): Promise<string> {
  if (!registryEntityId) {
    registryEntityId = `of:${await sha256("ct:webhooks-registry")}`;
  }
  return registryEntityId;
}

export async function getWebhookRegistry(
  space: string,
): Promise<WebhookRegistration[]> {
  try {
    const entityId = await getRegistryEntityId();
    const cellLink = {
      "/": {
        "link-v0.1": {
          id: entityId,
          space,
          path: ["webhooks"],
        },
      },
    };

    // deno-lint-ignore no-explicit-any
    const cell = runtime.getCellFromLink(cellLink as any);
    await cell.sync();
    await runtime.storageManager.synced();

    const data = cell.get();
    if (!data || !Array.isArray(data)) return [];
    return data as WebhookRegistration[];
  } catch (error) {
    logger.error("webhook-registry", "Error reading webhook registry", error);
    return [];
  }
}

export async function saveWebhookRegistry(
  space: string,
  registrations: WebhookRegistration[],
): Promise<void> {
  const entityId = await getRegistryEntityId();
  const cellLink = {
    "/": {
      "link-v0.1": {
        id: entityId,
        space,
        path: ["webhooks"],
      },
    },
  };

  // deno-lint-ignore no-explicit-any
  const cell = runtime.getCellFromLink(cellLink as any);
  await cell.sync();
  await runtime.storageManager.synced();

  const { error } = await cell.runtime.editWithRetry((tx) => {
    cell.withTx(tx).set(registrations);
  });
  if (error) throw error;
}

export async function writeToCell(
  cellLink: string,
  payload: unknown,
  mode: "replace" | "append",
): Promise<void> {
  const parsedCellLink = JSON.parse(cellLink);
  const cell = runtime.getCellFromLink(parsedCellLink);
  await cell.sync();
  await runtime.storageManager.synced();

  if (mode === "replace") {
    const { error } = await cell.runtime.editWithRetry((tx) => {
      cell.withTx(tx).set(payload);
    });
    if (error) throw error;
  } else {
    // append mode
    const { error } = await cell.runtime.editWithRetry((tx) => {
      const current = cell.get();
      const items = Array.isArray(current)
        ? current
        : current != null
        ? [current]
        : [];
      const updated = [
        ...items.slice(-(MAX_APPEND_ITEMS - 1)),
        {
          ...(payload as Record<string, unknown>),
          _receivedAt: new Date().toISOString(),
        },
      ];
      cell.withTx(tx).set(updated);
    });
    if (error) throw error;
  }
}

// Rebuild the in-memory index from a space's registry
export async function rebuildIndex(space: string): Promise<void> {
  const registrations = await getWebhookRegistry(space);
  for (const reg of registrations) {
    if (reg.enabled) {
      webhookIndex.set(reg.id, { registration: reg, space });
    } else {
      webhookIndex.delete(reg.id);
    }
  }
}

// Extract space DID from a serialized cell link
export function extractSpaceFromCellLink(cellLink: string): string {
  const parsed = JSON.parse(cellLink);
  const link = parsed["/"];
  if (!link) throw new Error("Invalid cell link format");

  // Handle link-v0.1 format
  const linkData = link["link-v0.1"];
  if (!linkData?.space) throw new Error("Cell link missing space");

  return linkData.space;
}
