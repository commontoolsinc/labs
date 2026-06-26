import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import type { AppRouteHandler } from "@/lib/types.ts";
import { runtime } from "@/index.ts";
import {
  assertIngestAuthorized,
  ChannelNotAuthorizedError,
} from "@/lib/channel-acl.ts";
import { appendLocationPoints } from "./location-ingest.utils.ts";
import type { IngestRoute } from "./location-ingest.routes.ts";

export const ingest: AppRouteHandler<IngestRoute> = async (c) => {
  const logger = c.get("logger");
  const { auth, points } = c.req.valid("json");

  // Authenticate the presenter via the unchanged session.open verification.
  // The channel space is the invocation subject (auth.space); a self-signed
  // open with prf:[] goes through this path untouched.
  let presenter: string;
  try {
    presenter = await verifySessionOpenAuthorization(auth);
  } catch (error) {
    logger.warn({ error }, "location-ingest: session.open verification failed");
    return c.json({ error: "Unauthorized" }, 401);
  }

  // CRITICAL: a verified session.open proves only that the presenter controls
  // its issuer DID — NOT any relationship to auth.space, which is
  // attacker-chosen. Without this gate, any did:key holder could deposit
  // operator-signed, ExternalIngest-stamped bytes into any space they name.
  // Fail closed against the authorized-channel set before writing anything.
  try {
    assertIngestAuthorized(auth.space);
  } catch (error) {
    if (error instanceof ChannelNotAuthorizedError) {
      logger.warn(
        { presenter, channel: auth.space },
        "location-ingest: rejected ingest to unauthorized channel space",
      );
      return c.json({ error: "Channel not authorized" }, 403);
    }
    throw error;
  }

  try {
    const { appended } = await appendLocationPoints(
      runtime,
      { channelSpace: auth.space, presenter },
      points,
    );
    logger.info(
      { presenter, channel: auth.space, appended },
      "location-ingest: appended points",
    );
    return c.json({ appended }, 200);
  } catch (error) {
    logger.error({ error }, "location-ingest: failed to append points");
    return c.json({ error: "Failed to ingest location points" }, 502);
  }
};
