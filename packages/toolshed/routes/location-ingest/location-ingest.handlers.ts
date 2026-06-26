import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import type { AppRouteHandler } from "@/lib/types.ts";
import { runtime } from "@/index.ts";
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
