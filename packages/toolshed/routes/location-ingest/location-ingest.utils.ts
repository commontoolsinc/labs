import type { JSONSchema, MemorySpace, Runtime } from "@commonfabric/runner";
import { custodyIngest, type VouchedChannel } from "@/lib/custody-ingest.ts";

/**
 * A single location reading the iOS beacon records. Mirrors the browser
 * Geolocation shape (cf-location component) — the fields the beacon already
 * has — so the ingested trail is directly renderable.
 */
export type LocationPoint = {
  latitude: number;
  longitude: number;
  accuracy: number;
  /** Epoch millis when the device captured the reading. */
  timestamp: number;
  altitude?: number;
  altitudeAccuracy?: number;
  heading?: number;
  speed?: number;
};

export const LocationPointSchema = {
  type: "object",
  properties: {
    latitude: { type: "number" },
    longitude: { type: "number" },
    accuracy: { type: "number" },
    timestamp: { type: "number" },
    altitude: { type: "number" },
    altitudeAccuracy: { type: "number" },
    heading: { type: "number" },
    speed: { type: "number" },
  },
  required: ["latitude", "longitude", "accuracy", "timestamp"],
} as const satisfies JSONSchema;

const LocationDaySchema = {
  type: "array",
  items: LocationPointSchema,
} as const satisfies JSONSchema;

// FLAG (for Berni / the beacon team): per-day cells are keyed by the UTC date
// of the device timestamp, so a day's trail accumulates in one cell. The cause
// is scoped to the channel so two channels never share a day cell.
export const dayKeyOf = (timestampMillis: number): string =>
  new Date(timestampMillis).toISOString().slice(0, 10);

export const dayCellCause = (channelSpace: string, dayKey: string): string =>
  `location-trail:${channelSpace}:${dayKey}`;

/**
 * Durably append verified location points into the channel's per-day trail
 * cells, each under the ExternalIngest provenance mark. The presenter has
 * already been authenticated by the unchanged `session.open` verification; this
 * is the operator-side custody write (`as: identity`, operator-trusted v1).
 *
 * `channelSpace` is the location ingest channel (its own space) the presenter
 * was vouched into; `presenter` is recorded as the mark's audience (not
 * enforced — federation PR5).
 */
export const appendLocationPoints = async (
  runtime: Runtime,
  ingest: { channelSpace: string; presenter: string },
  points: readonly LocationPoint[],
): Promise<{ appended: number }> => {
  const channel: VouchedChannel = {
    channel: ingest.channelSpace,
    audience: ingest.presenter,
  };
  let appended = 0;
  for (const point of points) {
    const dayKey = dayKeyOf(point.timestamp);
    const cell = runtime.getCell<LocationPoint[]>(
      ingest.channelSpace as MemorySpace,
      dayCellCause(ingest.channelSpace, dayKey),
      LocationDaySchema,
    );
    await custodyIngest.append(cell, point, channel);
    appended += 1;
  }
  return { appended };
};
