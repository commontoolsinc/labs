import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { BENCH_MEMORY_VERSION } from "./bench-memory-version.ts";

const signer = await Identity.fromPassphrase("bench subscription refresh");
const space = signer.did();
const SUBSCRIPTION_COUNT = 256;
const UPDATE_COUNT = 5;
const SOURCE_LINK = { "/": "bench:source" } as const;

type TestProvider = ReturnType<typeof StorageManager.emulate> extends {
  open(space: string): infer T;
} ? T
  : never;

const buildPayload = (version: number) => ({
  meta: {
    version,
    label: "subscription-refresh",
  },
  items: Array.from({ length: SUBSCRIPTION_COUNT }, (_, index) => ({
    count: index === 0 ? version : index,
    label: `item-${index}`,
  })),
});

const buildStoredValue = (version: number, sourceBacked: boolean) =>
  sourceBacked
    ? {
      value: buildPayload(version),
      source: SOURCE_LINK,
    }
    : {
      value: buildPayload(version),
    };

const setup = async (sourceBacked: boolean) => {
  const storageManager = StorageManager.emulate({
    as: signer,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  const provider = storageManager.open(space) as unknown as TestProvider;
  const uri = `of:subscription-refresh-${crypto.randomUUID()}` as const;

  await (provider as any).send([{
    uri,
    value: buildStoredValue(0, sourceBacked),
  }]);

  for (let index = 0; index < SUBSCRIPTION_COUNT; index++) {
    await (provider as any).sync(uri, {
      path: ["items", String(index), "count"],
      schema: false,
    });
  }

  await storageManager.synced();
  return { storageManager, provider, uri };
};

const setupOnly = async (sourceBacked: boolean) => {
  const { storageManager } = await setup(sourceBacked);
  await cleanup(storageManager);
};

const cleanup = async (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await storageManager.close();
};

const runUpdateLoop = async (
  provider: TestProvider,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  uri: string,
  sourceBacked: boolean,
) => {
  for (let version = 1; version <= UPDATE_COUNT; version++) {
    await (provider as any).send([{
      uri,
      value: buildStoredValue(version, sourceBacked),
    }]);
    await storageManager.synced();
  }
};

Deno.bench(
  "Storage - subscription setup plain doc (256 selectors)",
  { group: "subscription-refresh" },
  async () => {
    await setupOnly(false);
  },
);

Deno.bench(
  "Storage - subscription setup source-backed doc (256 selectors)",
  { group: "subscription-refresh" },
  async () => {
    await setupOnly(true);
  },
);

Deno.bench(
  "Storage - subscription refresh plain doc (256 selectors, 5 updates)",
  { group: "subscription-refresh" },
  async () => {
    const { storageManager, provider, uri } = await setup(false);
    try {
      await runUpdateLoop(provider, storageManager, uri, false);
    } finally {
      await cleanup(storageManager);
    }
  },
);

Deno.bench(
  "Storage - subscription refresh source-backed doc (256 selectors, 5 updates)",
  { group: "subscription-refresh" },
  async () => {
    const { storageManager, provider, uri } = await setup(true);
    try {
      await runUpdateLoop(provider, storageManager, uri, true);
    } finally {
      await cleanup(storageManager);
    }
  },
);
