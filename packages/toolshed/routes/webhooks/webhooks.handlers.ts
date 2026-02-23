import env from "@/env.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import { sha256 } from "@/lib/sha2.ts";
import type {
  CreateRoute,
  IngestRoute,
  ListRoute,
  RemoveRoute,
} from "./webhooks.routes.ts";
import {
  addToServiceIndex,
  deleteRegistration,
  extractSpaceFromCellLink,
  generateWebhookId,
  generateWebhookSecret,
  getRegistration,
  getServiceIndex,
  removeFromServiceIndex,
  saveRegistration,
  verifyWebhookSecret,
  writeConfidentialConfig,
  writeToCell,
} from "./webhooks.utils.ts";

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const {
      name,
      cellLink,
      confidentialCellLink,
      mode = "replace",
    } = await c.req.json();

    if (!name || !cellLink || !confidentialCellLink) {
      return c.json(
        {
          error:
            "Missing required fields: name, cellLink, confidentialCellLink",
        },
        400,
      );
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

    const registration = {
      id,
      name,
      cellLink,
      secretHash,
      createdBy: space,
      createdAt: new Date().toISOString(),
      enabled: true,
      mode,
    };

    // Store registration in toolshed's service space
    await saveRegistration(registration);

    // Update the per-space index
    await addToServiceIndex(space, id);

    // Write URL+secret to the pattern's confidential config cell
    const url = `${env.API_URL}/api/webhooks/${id}`;
    await writeConfidentialConfig(confidentialCellLink, url, secret);

    logger.info({ id, name, mode, space }, "Webhook created");

    return c.json({ id, name, mode }, 200);
  } catch (error) {
    logger.error({ error }, "Failed to create webhook");
    return c.json({ error: "Failed to create webhook" }, 400);
  }
};

export const ingest: AppRouteHandler<IngestRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();

  // Extract bearer token FIRST (before any storage lookup)
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Invalid request" }, 401);
  }
  const token = authHeader.slice(7);

  // Look up registration from shared storage
  const registration = await getRegistration(id);

  if (!registration || !registration.enabled) {
    // Hash token against dummy to prevent timing oracle on missing webhooks
    await sha256(token);
    return c.json({ error: "Invalid request" }, 401);
  }

  // Verify bearer token
  const valid = await verifyWebhookSecret(token, registration.secretHash);
  if (!valid) {
    return c.json({ error: "Invalid request" }, 401);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  try {
    await writeToCell(registration.cellLink, payload, registration.mode);
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
    // Read per-space index to get webhook IDs
    const webhookIds = await getServiceIndex(space);

    // Fetch each registration and strip secretHash
    const webhooks = [];
    for (const webhookId of webhookIds) {
      const reg = await getRegistration(webhookId);
      if (reg) {
        const { secretHash: _, ...rest } = reg;
        webhooks.push(rest);
      }
    }

    return c.json({ webhooks }, 200);
  } catch (error) {
    logger.error({ error }, "Failed to list webhooks");
    return c.json({ error: "Failed to list webhooks" }, 400);
  }
};

export const remove: AppRouteHandler<RemoveRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();

  try {
    const registration = await getRegistration(id);

    if (!registration) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    // Derive space from the stored registration's cellLink
    const space = extractSpaceFromCellLink(registration.cellLink);

    // Remove from service index and null out the registration
    await removeFromServiceIndex(space, id);
    await deleteRegistration(id);

    logger.info({ id, space }, "Webhook deleted");

    return c.json({ deleted: true }, 200);
  } catch (error) {
    logger.error({ error, id }, "Failed to delete webhook");
    return c.json({ error: "Failed to delete webhook" }, 400);
  }
};
