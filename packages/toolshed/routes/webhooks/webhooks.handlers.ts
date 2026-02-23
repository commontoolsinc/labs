import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  CreateRoute,
  IngestRoute,
  ListRoute,
  RemoveRoute,
} from "./webhooks.routes.ts";
import {
  extractSpaceFromCellLink,
  generateWebhookId,
  generateWebhookSecret,
  getWebhookIndex,
  getWebhookRegistry,
  rebuildIndex,
  saveWebhookRegistry,
  verifyWebhookSecret,
  writeToCell,
  type WebhookRegistration,
} from "./webhooks.utils.ts";

const MAX_PAYLOAD_SIZE = 1_000_000; // 1MB

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const { name, cellLink, mode = "replace" } = await c.req.json();

    if (!name || !cellLink) {
      return c.json({ error: "Missing required fields: name, cellLink" }, 400);
    }

    // Validate cellLink format and extract space
    let space: string;
    try {
      space = extractSpaceFromCellLink(cellLink);
    } catch {
      return c.json({ error: "Invalid cellLink format" }, 400);
    }

    const id = generateWebhookId();
    const { secret, hashPromise } = generateWebhookSecret();
    const secretHash = await hashPromise;

    const registration: WebhookRegistration = {
      id,
      name,
      cellLink,
      secretHash,
      createdBy: space, // In v1, scoped to space owner
      createdAt: new Date().toISOString(),
      enabled: true,
      mode,
      deliveryCount: 0,
    };

    // Read existing registry and append
    const registrations = await getWebhookRegistry(space);
    registrations.push(registration);
    await saveWebhookRegistry(space, registrations);

    // Update in-memory index
    await rebuildIndex(space);

    const baseUrl = new URL(c.req.url).origin;
    const url = `${baseUrl}/api/webhooks/${id}`;

    logger.info({ id, name, mode, space }, "Webhook created");

    return c.json({ id, url, secret, name, mode }, 200);
  } catch (error) {
    logger.error({ error }, "Failed to create webhook");
    return c.json({ error: "Failed to create webhook" }, 400);
  }
};

export const ingest: AppRouteHandler<IngestRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();

  // Look up webhook in index
  const entry = getWebhookIndex().get(id);
  if (!entry) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  const { registration, space } = entry;

  if (!registration.enabled) {
    return c.json({ error: "Webhook is disabled" }, 404);
  }

  // Verify bearer token
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const valid = await verifyWebhookSecret(token, registration.secretHash);
  if (!valid) {
    return c.json({ error: "Invalid bearer token" }, 401);
  }

  // Check payload size
  const contentLength = c.req.header("Content-Length");
  if (contentLength && parseInt(contentLength) > MAX_PAYLOAD_SIZE) {
    return c.json({ error: "Payload too large (max 1MB)" }, 400);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  try {
    await writeToCell(registration.cellLink, payload, registration.mode);

    // Update delivery stats
    registration.lastReceivedAt = new Date().toISOString();
    registration.deliveryCount++;

    // Persist updated stats
    const registrations = await getWebhookRegistry(space);
    const idx = registrations.findIndex((r) => r.id === id);
    if (idx !== -1) {
      registrations[idx] = registration;
      await saveWebhookRegistry(space, registrations);
    }

    logger.info({ id, mode: registration.mode }, "Webhook payload received");

    return c.json({ received: true }, 200);
  } catch (error) {
    logger.error({ error, id }, "Failed to write webhook payload to cell");
    return c.json({ error: "Failed to write payload" }, 400);
  }
};

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const logger = c.get("logger");
  const space = c.req.query("space");

  if (!space) {
    return c.json({ error: "Missing required query parameter: space" }, 400);
  }

  try {
    const registrations = await getWebhookRegistry(space);

    // Strip secretHash from response
    const webhooks = registrations.map(({ secretHash: _, ...rest }) => rest);

    return c.json({ webhooks }, 200);
  } catch (error) {
    logger.error({ error }, "Failed to list webhooks");
    return c.json({ error: "Failed to list webhooks" }, 400);
  }
};

export const remove: AppRouteHandler<RemoveRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();
  const space = c.req.query("space");

  if (!space) {
    return c.json({ error: "Missing required query parameter: space" }, 400);
  }

  try {
    const registrations = await getWebhookRegistry(space);
    const idx = registrations.findIndex((r) => r.id === id);

    if (idx === -1) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    registrations.splice(idx, 1);
    await saveWebhookRegistry(space, registrations);

    // Remove from in-memory index
    getWebhookIndex().delete(id);

    logger.info({ id, space }, "Webhook deleted");

    return c.json({ deleted: true }, 200);
  } catch (error) {
    logger.error({ error, id }, "Failed to delete webhook");
    return c.json({ error: "Failed to delete webhook" }, 400);
  }
};
