import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  appendLocationPoints,
  dayCellCause,
  dayKeyOf,
  type LocationPoint,
} from "./location-ingest.utils.ts";

const PRESENTER = "did:key:beacon-install";

const point = (timestamp: number, lat: number): LocationPoint => ({
  latitude: lat,
  longitude: -122.4,
  accuracy: 5,
  timestamp,
});

// The location ingest endpoint's operator-side custody write: verified location
// points are durably appended into per-day trail cells, each under the
// ExternalIngest mark. Auth (the presenter's session.open) is the unchanged
// verification path, tested elsewhere; this covers the append + mark.
describe("appendLocationPoints", () => {
  let signer: Identity;
  let channelSpace: ReturnType<Identity["did"]>;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("location-ingest-test");
    channelSpace = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://location-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const dayCellId = (dayKey: string): string =>
    runtime.getCell(channelSpace, dayCellCause(channelSpace, dayKey))
      .getAsNormalizedFullLink().id;

  const ingestMarks = (
    id: string,
  ): { audience?: string; channel?: string }[] => {
    const replica = storageManager.open(channelSpace).replica as unknown as {
      getDocument(id: string): {
        cfc?: {
          labelMap?: {
            entries: { label: { integrity?: unknown[] }; origin?: string }[];
          };
        };
      } | undefined;
    };
    return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((e) => e.origin === "external-ingest")
      .flatMap((e) => e.label.integrity ?? []) as {
        audience?: string;
        channel?: string;
      }[];
  };

  it("appends points to per-day cells under the ExternalIngest mark", async () => {
    const t = Date.parse("2026-06-26T09:00:00.000Z");
    const result = await appendLocationPoints(
      runtime,
      { channelSpace, presenter: PRESENTER },
      [point(t, 37.1), point(t + 60_000, 37.2)],
    );
    expect(result.appended).toBe(2);

    const id = dayCellId(dayKeyOf(t));
    const cell = runtime.getCell<LocationPoint[]>(
      channelSpace,
      dayCellCause(channelSpace, dayKeyOf(t)),
    );
    // Both points accumulated in the one day cell.
    expect((cell.get() as LocationPoint[]).map((p) => p.latitude))
      .toEqual([37.1, 37.2]);

    // The day cell carries the mark, audience = the presenter the channel was
    // vouched to, channel = the ingest space.
    const marks = ingestMarks(id);
    expect(marks.length).toBe(1);
    expect((marks[0] as { type?: string }).type).toBe(
      CFC_ATOM_TYPE.ExternalIngest,
    );
    expect(marks[0].audience).toBe(PRESENTER);
    expect(marks[0].channel).toBe(channelSpace);
  });

  it("splits points across days into separate trail cells", async () => {
    const day1 = Date.parse("2026-06-26T23:00:00.000Z");
    const day2 = Date.parse("2026-06-27T01:00:00.000Z");
    await appendLocationPoints(
      runtime,
      { channelSpace, presenter: PRESENTER },
      [point(day1, 1), point(day2, 2)],
    );

    const cell1 = runtime.getCell<LocationPoint[]>(
      channelSpace,
      dayCellCause(channelSpace, dayKeyOf(day1)),
    );
    const cell2 = runtime.getCell<LocationPoint[]>(
      channelSpace,
      dayCellCause(channelSpace, dayKeyOf(day2)),
    );
    expect((cell1.get() as LocationPoint[]).length).toBe(1);
    expect((cell2.get() as LocationPoint[]).length).toBe(1);
    expect(dayKeyOf(day1)).not.toBe(dayKeyOf(day2));
  });
});
