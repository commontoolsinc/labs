import { getLogger } from "@commontools/utils/logger";
import { sha256 } from "@/lib/sha2.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import { WebhookConfigSchema } from "@commontools/runner";

const logger = getLogger("webhooks.utils");

const WEBHOOK_ID_LENGTH = 20;
const WEBHOOK_SECRET_BYTES = 32;

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
}

function randomBase62(length: number): string {
  // Use rejection sampling to avoid modulo bias (256 % 62 != 0).
  // Discard bytes >= 248 (largest multiple of 62 <= 256) and redraw.
  const LIMIT = 248; // 62 * 4
  let result = "";
  while (result.length < length) {
    const bytes = crypto.getRandomValues(
      new Uint8Array((length - result.length) * 2),
    );
    for (const byte of bytes) {
      if (byte < LIMIT) {
        result += BASE62[byte % 62];
        if (result.length === length) break;
      }
    }
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
  const encoded = randomBase62(WEBHOOK_SECRET_BYTES);
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

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// Compute entity ID for a webhook registration in toolshed's service space
export async function webhookEntityId(webhookId: string): Promise<string> {
  return `of:${await sha256("ct:webhook:" + webhookId)}`;
}

// Compute entity ID for a per-space webhook index in toolshed's service space
async function spaceIndexEntityId(space: string): Promise<string> {
  return `of:${await sha256("ct:webhooks-for:" + space)}`;
}

// Build a cell link targeting toolshed's own service space
function serviceCellLink(entityId: string) {
  return {
    "/": {
      "link@1": {
        id: entityId,
        space: identity.did(),
        path: ["webhooks"],
      },
    },
  };
}

// Read a cell from toolshed's service space, returning its value
async function readServiceCell<T>(entityId: string): Promise<T | null> {
  try {
    const link = serviceCellLink(entityId);
    const cell = runtime.getCellFromLink(link as any);
    await cell.sync();
    await runtime.storageManager.synced();
    const data = cell.get();
    return data as T | null;
  } catch (error) {
    logger.error("service-cell-read", "Error reading service cell", error);
    return null;
  }
}

// Write a value to a cell in toolshed's service space
async function writeServiceCell(
  entityId: string,
  value: unknown,
): Promise<void> {
  const link = serviceCellLink(entityId);
  const cell = runtime.getCellFromLink(link as any);
  await cell.sync();
  await runtime.storageManager.synced();

  const { error } = await cell.runtime.editWithRetry((tx) => {
    cell.withTx(tx).set(value);
  });
  if (error) throw error;
}

// Read a single webhook registration from toolshed's service space
export async function getRegistration(
  webhookId: string,
): Promise<WebhookRegistration | null> {
  const entityId = await webhookEntityId(webhookId);
  return readServiceCell<WebhookRegistration>(entityId);
}

// Write a single webhook registration to toolshed's service space
export async function saveRegistration(
  registration: WebhookRegistration,
): Promise<void> {
  const entityId = await webhookEntityId(registration.id);
  await writeServiceCell(entityId, registration);
}

// Null out a webhook registration
export async function deleteRegistration(webhookId: string): Promise<void> {
  const entityId = await webhookEntityId(webhookId);
  await writeServiceCell(entityId, null);
}

// Write URL+secret to a pattern's confidential config cell
export async function writeConfidentialConfig(
  cellLink: string,
  url: string,
  secret: string,
): Promise<void> {
  const parsedCellLink = JSON.parse(cellLink);
  let cell = runtime.getCellFromLink(parsedCellLink);
  if (!cell.schema) cell = cell.asSchema(WebhookConfigSchema);
  await cell.sync();
  await runtime.storageManager.synced();

  const { error } = await cell.runtime.editWithRetry((tx) => {
    cell.withTx(tx).set({ url, secret });
  });
  if (error) throw error;
}

// Per-space index of webhook IDs in toolshed's service space (for admin list)
export async function getServiceIndex(space: string): Promise<string[]> {
  const entityId = await spaceIndexEntityId(space);
  const data = await readServiceCell<string[]>(entityId);
  return data ?? [];
}

export async function addToServiceIndex(
  space: string,
  webhookId: string,
): Promise<void> {
  const entityId = await spaceIndexEntityId(space);
  const link = serviceCellLink(entityId);
  const cell = runtime.getCellFromLink(link as any);
  await cell.sync();
  await runtime.storageManager.synced();

  const { error } = await cell.runtime.editWithRetry((tx) => {
    const current = cell.get();
    const ids: string[] = Array.isArray(current) ? current : [];
    if (!ids.includes(webhookId)) {
      cell.withTx(tx).set([...ids, webhookId]);
    }
  });
  if (error) throw error;
}

export async function removeFromServiceIndex(
  space: string,
  webhookId: string,
): Promise<void> {
  const entityId = await spaceIndexEntityId(space);
  const link = serviceCellLink(entityId);
  const cell = runtime.getCellFromLink(link as any);
  await cell.sync();
  await runtime.storageManager.synced();

  const { error } = await cell.runtime.editWithRetry((tx) => {
    const current = cell.get();
    const ids: string[] = Array.isArray(current) ? current : [];
    cell.withTx(tx).set(ids.filter((id) => id !== webhookId));
  });
  if (error) throw error;
}

// Send incoming webhook payload to the target inbox stream
export async function sendToStream(
  cellLink: string,
  payload: unknown,
): Promise<void> {
  const parsedCellLink = JSON.parse(cellLink);
  const cell = runtime.getCellFromLink(parsedCellLink);
  await cell.sync();
  await runtime.storageManager.synced();

  const { error } = await cell.runtime.editWithRetry((tx) => {
    cell.withTx(tx).send(payload);
  });
  if (error) throw error;
}

// Extract space DID from a serialized cell link
export function extractSpaceFromCellLink(cellLink: string): string {
  const parsed = JSON.parse(cellLink);
  const link = parsed["/"];
  if (!link) throw new Error("Invalid cell link format");

  const linkData = link["link@1"] ?? link["link-v0.1"];
  if (!linkData?.space) throw new Error("Cell link missing space");

  return linkData.space;
}
