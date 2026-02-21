import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("bench traverse e2e");
const space = signer.did();

type ItemValue = {
  id: number;
  profile: {
    name: string;
    tags: string[];
    stats: {
      score: number;
      level: number;
    };
  };
  eventBus: { $stream: true };
  metrics: {
    views: number;
    clicks: number;
    conversion: {
      day: number;
      total: number;
    };
  };
  relations: {
    parent: number | null;
    siblings: number[];
  };
};

const itemProjectionSchema = {
  type: "object",
  properties: {
    id: { type: "number" },
    profile: {
      type: "object",
      asCell: true,
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        stats: {
          type: "object",
          properties: {
            score: { type: "number" },
            level: { type: "number" },
          },
          required: ["score", "level"],
        },
      },
      required: ["name", "tags", "stats"],
    },
    eventBus: { asStream: true },
    metrics: {
      type: "object",
      properties: {
        views: { type: "number" },
        clicks: { type: "number" },
        conversion: {
          type: "object",
          properties: {
            day: { type: "number" },
            total: { type: "number" },
          },
          required: ["day", "total"],
        },
      },
      required: ["views", "clicks", "conversion"],
    },
    relations: {
      type: "object",
      properties: {
        parent: { type: ["number", "null"] },
        siblings: { type: "array", items: { type: "number" } },
      },
      required: ["parent", "siblings"],
    },
  },
  required: ["id", "profile", "eventBus", "metrics", "relations"],
} as const satisfies JSONSchema;

const projectionSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    version: { type: "number" },
    highlighted: itemProjectionSchema,
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: itemProjectionSchema,
          },
        },
        required: ["name", "items"],
      },
    },
    lookup: {
      type: "object",
      additionalProperties: itemProjectionSchema,
    },
    analytics: {
      type: "object",
      properties: {
        generatedAt: { type: "string" },
        flags: {
          type: "object",
          properties: {
            hot: { type: "boolean" },
            stale: { type: "boolean" },
          },
          required: ["hot", "stale"],
        },
      },
      required: ["generatedAt", "flags"],
    },
  },
  required: [
    "title",
    "version",
    "highlighted",
    "sections",
    "lookup",
    "analytics",
  ],
} as const satisfies JSONSchema;

function setup() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  runtime.scheduler.disablePullMode();
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) {
  if (tx?.status().status === "ready") {
    await tx.commit();
  }
  await runtime.dispose();
  await storageManager.close();
}

function makeItemValue(index: number, total: number): ItemValue {
  return {
    id: index,
    profile: {
      name: `item-${index}`,
      tags: [`tag-${index % 7}`, `tier-${index % 3}`, `group-${index % 5}`],
      stats: {
        score: index * 11,
        level: index % 10,
      },
    },
    eventBus: { $stream: true },
    metrics: {
      views: 1000 + index * 3,
      clicks: 100 + index,
      conversion: {
        day: index % 20,
        total: index * 2,
      },
    },
    relations: {
      parent: index === 0 ? null : index - 1,
      siblings: [
        (index + 1) % total,
        (index + 2) % total,
        (index + 3) % total,
      ],
    },
  };
}

function readProjectedItemChecks(item: unknown) {
  if (typeof item !== "object" || item === null) {
    throw new Error("Projected item is not an object");
  }
  const itemRecord = item as Record<string, unknown>;
  const profile = itemRecord.profile as Record<string, unknown> | undefined;
  if (typeof profile?.get !== "function") {
    throw new Error("Projected item.profile is not a cell-like value");
  }
  const eventBus = itemRecord.eventBus as Record<string, unknown> | undefined;
  if (typeof eventBus?.send !== "function") {
    throw new Error("Projected item.eventBus is not a stream-like value");
  }
  const profileValue = profile.get.call(profile) as Record<string, unknown>;
  if (typeof profileValue?.name !== "string") {
    throw new Error("Projected profile value is invalid");
  }
  const metrics = itemRecord.metrics as Record<string, unknown> | undefined;
  if (
    typeof metrics?.views !== "number" || typeof metrics?.clicks !== "number"
  ) {
    throw new Error("Projected item.metrics is invalid");
  }
}

function seedComplexGraph(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  prefix: string,
) {
  const itemCount = 60;
  const itemCells = Array.from(
    { length: itemCount },
    (_unused, index) =>
      runtime.getCell<ItemValue>(
        space,
        `${prefix}-item-${index}`,
        undefined,
        tx,
      ),
  );
  const itemValues = itemCells.map((_cell, index) =>
    makeItemValue(index, itemCount)
  );

  for (let index = 0; index < itemCount; index++) {
    itemCells[index].set(itemValues[index]);
  }

  const sectionCount = 4;
  const sectionSize = itemCount / sectionCount;
  const sections = Array.from(
    { length: sectionCount },
    (_unused, sectionIndex) => {
      const start = sectionIndex * sectionSize;
      const end = start + sectionSize;
      return {
        name: `section-${sectionIndex}`,
        items: itemCells.slice(start, end),
      };
    },
  );

  const lookup: Record<string, unknown> = {};
  for (let index = 0; index < 24; index++) {
    lookup[`k${index}`] = itemCells[index];
  }

  const rootCell = runtime.getCell<Record<string, unknown>>(
    space,
    `${prefix}-root`,
    undefined,
    tx,
  );
  rootCell.set({
    title: "benchmark-catalog",
    version: 1,
    highlighted: itemCells[5],
    sections,
    lookup,
    analytics: {
      generatedAt: "2026-02-21T00:00:00.000Z",
      flags: { hot: true, stale: false },
    },
  });

  return { rootCell, itemCells, itemValues };
}

Deno.bench(
  "traverse.e2e linked catalog projection (traverseCells=false, 30x)",
  { group: "traverse-e2e" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    const { rootCell } = seedComplexGraph(runtime, tx, "bench-e2e-projection");
    await tx.commit();

    const projectedCell = rootCell.asSchema(projectionSchema);

    b.start();
    for (let i = 0; i < 30; i++) {
      const value = projectedCell.get() as Record<string, unknown>;
      const sections = value.sections as unknown[];
      if (!Array.isArray(sections) || sections.length === 0) {
        throw new Error("Projected sections are missing");
      }
      const section = sections[i % sections.length] as Record<string, unknown>;
      const items = section.items as unknown[];
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("Projected items are missing");
      }
      readProjectedItemChecks(items[i % items.length]);

      const lookup = value.lookup as Record<string, unknown>;
      readProjectedItemChecks(lookup[`k${i % 24}`]);
      readProjectedItemChecks(value.highlighted);
    }
    b.end();

    await cleanup(runtime, storageManager);
  },
);

Deno.bench(
  "traverse.e2e linked catalog dependency read (traverseCells=true, 20x)",
  { group: "traverse-e2e" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    const { rootCell } = seedComplexGraph(runtime, tx, "bench-e2e-deps");
    await tx.commit();

    const projectedCell = rootCell.asSchema(projectionSchema);

    b.start();
    for (let i = 0; i < 20; i++) {
      const value = projectedCell.get({ traverseCells: true }) as Record<
        string,
        unknown
      >;
      const sections = value.sections as unknown[];
      if (!Array.isArray(sections) || sections.length === 0) {
        throw new Error("Projected sections are missing");
      }
      const section = sections[i % sections.length] as Record<string, unknown>;
      const items = section.items as unknown[];
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("Projected items are missing");
      }
      readProjectedItemChecks(items[i % items.length]);
    }
    b.end();

    await cleanup(runtime, storageManager);
  },
);

Deno.bench(
  "traverse.e2e linked graph update + projection read cycle (15x)",
  { group: "traverse-e2e-update" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();

    const { rootCell, itemCells, itemValues } = seedComplexGraph(
      runtime,
      tx,
      "bench-e2e-update",
    );
    await tx.commit();

    const projectedCell = rootCell.asSchema(projectionSchema);

    b.start();
    for (let i = 0; i < 15; i++) {
      const itemIndex = i % itemCells.length;
      const prev = itemValues[itemIndex];
      const next: ItemValue = {
        ...prev,
        profile: {
          ...prev.profile,
          tags: [
            prev.profile.tags[0],
            prev.profile.tags[1],
            `updated-${i % 5}`,
          ],
          stats: {
            score: prev.profile.stats.score + 7,
            level: prev.profile.stats.level + 1,
          },
        },
        metrics: {
          ...prev.metrics,
          views: prev.metrics.views + 13,
          clicks: prev.metrics.clicks + 3,
          conversion: {
            day: prev.metrics.conversion.day,
            total: prev.metrics.conversion.total + 2,
          },
        },
      };
      itemValues[itemIndex] = next;

      const updateTx = runtime.edit();
      itemCells[itemIndex].withTx(updateTx).set(next);
      await updateTx.commit();

      const value = projectedCell.get({ traverseCells: true }) as Record<
        string,
        unknown
      >;
      const lookup = value.lookup as Record<string, unknown>;
      readProjectedItemChecks(lookup[`k${itemIndex % 24}`]);
    }
    b.end();

    await cleanup(runtime, storageManager);
  },
);
