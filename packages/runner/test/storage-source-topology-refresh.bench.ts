import { Identity } from "@commonfabric/identity";
import { refer } from "@commonfabric/memory/reference";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { BENCH_MEMORY_VERSION } from "./bench-memory-version.ts";

const signer = await Identity.fromPassphrase("bench source topology refresh");
const space = signer.did();
const SUBSCRIPTION_COUNT = 256;
const UPDATE_COUNT = 5;
const PROCESS_URI = "of:source-topology-process" as const;
const BASE_URIS = [
  "of:source-topology-base-1",
  "of:source-topology-base-2",
] as const;
const PATTERN_ID = "bench-pattern:source-topology";
const PATTERN_URI = `of:${
  refer({ causal: { patternId: PATTERN_ID, type: "pattern" } }).toJSON()["/"]
}` as const;

type TestProvider = ReturnType<typeof StorageManager.emulate> extends {
  open(space: string): infer T;
} ? T
  : never;

const pieceUri = (index: number) =>
  `of:source-topology-piece-${index}` as const;

const pieceValue = (withPatternLink: boolean) =>
  withPatternLink
    ? {
      source: { "/": "source-topology-process" },
      value: { $TYPE: PATTERN_ID },
    }
    : {
      source: { "/": "source-topology-process" },
    };

const setup = async (withPatternLink: boolean) => {
  const storageManager = StorageManager.emulate({
    as: signer,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  const provider = storageManager.open(space) as unknown as TestProvider;

  await (provider as any).send([
    {
      uri: BASE_URIS[0],
      value: {
        value: { label: "Base 1" },
      },
    },
    {
      uri: BASE_URIS[1],
      value: {
        value: { label: "Base 2" },
      },
    },
    {
      uri: PROCESS_URI,
      value: {
        source: { "/": "source-topology-base-1" },
      },
    },
    ...(withPatternLink
      ? [{
        uri: PATTERN_URI,
        value: {
          value: { name: "Bench Pattern" },
        },
      }]
      : []),
    ...Array.from({ length: SUBSCRIPTION_COUNT }, (_, index) => ({
      uri: pieceUri(index),
      value: pieceValue(withPatternLink),
    })),
  ]);

  for (let index = 0; index < SUBSCRIPTION_COUNT; index++) {
    await (provider as any).sync(pieceUri(index), {
      path: [],
      schema: false,
    });
  }

  await storageManager.synced();
  return { storageManager, provider };
};

const cleanup = async (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await storageManager.close();
};

const runRetargetLoop = async (
  provider: TestProvider,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  for (let version = 0; version < UPDATE_COUNT; version++) {
    await (provider as any).send([{
      uri: PROCESS_URI,
      value: {
        source: {
          "/": version % 2 === 0
            ? "source-topology-base-2"
            : "source-topology-base-1",
        },
      },
    }]);
    await storageManager.synced();
  }
};

Deno.bench(
  "Storage - source topology refresh plain roots (256 subscriptions, 5 retargets)",
  { group: "source-topology-refresh" },
  async () => {
    const { storageManager, provider } = await setup(false);
    try {
      await runRetargetLoop(provider, storageManager);
    } finally {
      await cleanup(storageManager);
    }
  },
);

Deno.bench(
  "Storage - source topology refresh pattern-linked roots (256 subscriptions, 5 retargets)",
  { group: "source-topology-refresh" },
  async () => {
    const { storageManager, provider } = await setup(true);
    try {
      await runRetargetLoop(provider, storageManager);
    } finally {
      await cleanup(storageManager);
    }
  },
);
