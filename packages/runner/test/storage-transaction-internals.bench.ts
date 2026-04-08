import {
  resetDataModelConfig,
  setDataModelConfig,
} from "@commonfabric/data-model/fabric-value";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { IAttestation } from "../src/storage/interface.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { V2StorageTransaction } from "../src/storage/v2-transaction.ts";
import { open as openChronicle } from "../src/storage/transaction/chronicle.ts";
import { create as createStorageTransaction } from "../src/storage/transaction.ts";
import {
  read as readAttestation,
  write as writeAttestation,
} from "../src/storage/transaction/attestation.ts";

const signer = await Identity.fromPassphrase(
  "storage-transaction-internals-bench",
);
const space = signer.did();
const id = "of:storage-transaction-internals";
const type = "application/json" as const;

const seedDocument = {
  value: {
    count: 0,
    label: "bench",
    nested: {
      value: 1,
    },
  },
};

const seedAttestation = (): IAttestation => ({
  address: { id, type, path: [] },
  value: seedDocument,
});

const seedV1Storage = async () => {
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v1",
  });
  const seed = storage.edit();
  const writeResult = seed.write({ space, id, type, path: [] }, {
    value: seedDocument.value,
  });
  if (writeResult.error) {
    throw writeResult.error;
  }
  await seed.commit();
  return storage;
};

const seedV2Storage = async () => {
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });
  const seed = storage.edit();
  const writeResult = seed.write({ space, id, type, path: [] }, {
    value: seedDocument.value,
  });
  if (writeResult.error) {
    throw writeResult.error;
  }
  await seed.commit();
  return storage;
};

Deno.bench("Storage tx internals - attestation root read x100", () => {
  const attestation = seedAttestation();
  for (let index = 0; index < 100; index += 1) {
    readAttestation(attestation, {
      id,
      type,
      path: ["value"],
    });
  }
});

Deno.bench("Storage tx internals - v1 chronicle root read x100", async () => {
  const storage = await seedV1Storage();
  try {
    const chronicle = openChronicle(storage.open(space).replica);
    chronicle.write({ id, type, path: [] }, seedDocument);
    for (let index = 0; index < 100; index += 1) {
      chronicle.read({ id, type, path: ["value"] });
    }
  } finally {
    await storage.close();
  }
});

Deno.bench("Storage tx internals - v1 storage tx root read x100", async () => {
  const storage = await seedV1Storage();
  try {
    const tx = createStorageTransaction(storage);
    tx.write({ space, id, type, path: [] }, seedDocument);
    for (let index = 0; index < 100; index += 1) {
      tx.read({ space, id, type, path: ["value"] });
    }
  } finally {
    await storage.close();
  }
});

Deno.bench("Storage tx internals - v2 transaction root read x100", async () => {
  const storage = await seedV2Storage();
  try {
    const tx = new V2StorageTransaction(storage);
    tx.write({ space, id, type, path: [] }, seedDocument);
    for (let index = 0; index < 100; index += 1) {
      tx.read({ space, id, type, path: ["value"] });
    }
  } finally {
    await storage.close();
  }
});

Deno.bench(
  "Storage tx internals - v2 transaction trackReadWithoutLoad root read x10000",
  async () => {
    const storage = await seedV2Storage();
    try {
      const tx = new V2StorageTransaction(storage);
      tx.write({ space, id, type, path: [] }, seedDocument);
      for (let index = 0; index < 10_000; index += 1) {
        tx.read({
          space,
          id,
          type,
          path: ["value"],
        }, { trackReadWithoutLoad: true });
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v1 storage tx warm root read x10000",
  async () => {
    const storage = await seedV1Storage();
    try {
      const tx = createStorageTransaction(storage);
      tx.write({ space, id, type, path: [] }, seedDocument);
      tx.read({ space, id, type, path: ["value"] });
      for (let index = 0; index < 10_000; index += 1) {
        tx.read({ space, id, type, path: ["value"] });
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v1 extended tx warm root read x10000",
  async () => {
    const storage = await seedV1Storage();
    try {
      const baseTx = createStorageTransaction(storage);
      const tx = new ExtendedStorageTransaction(baseTx);
      tx.write({ space, id, type, path: [] }, seedDocument);
      tx.readValueOrThrow({ space, id, type, path: [] });
      for (let index = 0; index < 10_000; index += 1) {
        tx.readValueOrThrow({ space, id, type, path: [] });
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v2 transaction warm root read x10000",
  async () => {
    const storage = await seedV2Storage();
    try {
      const tx = new V2StorageTransaction(storage);
      tx.write({ space, id, type, path: [] }, seedDocument);
      tx.read({ space, id, type, path: ["value"] });
      for (let index = 0; index < 10_000; index += 1) {
        tx.read({ space, id, type, path: ["value"] });
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v2 extended tx warm root read x10000",
  async () => {
    const storage = await seedV2Storage();
    try {
      const baseTx = new V2StorageTransaction(storage);
      const tx = new ExtendedStorageTransaction(baseTx);
      tx.write({ space, id, type, path: [] }, seedDocument);
      tx.readValueOrThrow({ space, id, type, path: [] });
      for (let index = 0; index < 10_000; index += 1) {
        tx.readValueOrThrow({ space, id, type, path: [] });
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v1 storage tx rich warm root read x10000",
  async () => {
    setDataModelConfig(true);
    const storage = await seedV1Storage();
    try {
      const tx = createStorageTransaction(storage);
      tx.write({ space, id, type, path: [] }, seedDocument);
      tx.read({ space, id, type, path: ["value"] });
      for (let index = 0; index < 10_000; index += 1) {
        tx.read({ space, id, type, path: ["value"] });
      }
    } finally {
      await storage.close();
      resetDataModelConfig();
    }
  },
);

Deno.bench(
  "Storage tx internals - v2 transaction rich warm root read x10000",
  async () => {
    setDataModelConfig(true);
    const storage = await seedV2Storage();
    try {
      const tx = new V2StorageTransaction(storage);
      tx.write({ space, id, type, path: [] }, seedDocument);
      tx.read({ space, id, type, path: ["value"] });
      for (let index = 0; index < 10_000; index += 1) {
        tx.read({ space, id, type, path: ["value"] });
      }
    } finally {
      await storage.close();
      resetDataModelConfig();
    }
  },
);

Deno.bench("Storage tx internals - attestation sibling write x100", () => {
  let attestation = seedAttestation();
  for (let index = 0; index < 100; index += 1) {
    const result = writeAttestation(attestation, {
      id,
      type,
      path: ["value", "count"],
    }, index);
    if (result.ok) {
      attestation = result.ok;
    }
  }
});

Deno.bench("Storage tx internals - attestation sibling read+write x100", () => {
  let attestation = seedAttestation();
  for (let index = 0; index < 100; index += 1) {
    readAttestation(attestation, {
      id,
      type,
      path: ["value", "count"],
    });
    const result = writeAttestation(attestation, {
      id,
      type,
      path: ["value", "count"],
    }, index);
    if (result.ok) {
      attestation = result.ok;
    }
  }
});

Deno.bench(
  "Storage tx internals - v1 chronicle sibling write x100",
  async () => {
    const storage = await seedV1Storage();
    try {
      const chronicle = openChronicle(storage.open(space).replica);
      chronicle.write({ id, type, path: [] }, seedDocument);
      for (let index = 0; index < 100; index += 1) {
        chronicle.write({ id, type, path: ["value", "count"] }, index);
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v1 storage tx sibling write x100",
  async () => {
    const storage = await seedV1Storage();
    try {
      const tx = createStorageTransaction(storage);
      tx.write({ space, id, type, path: [] }, seedDocument);
      for (let index = 0; index < 100; index += 1) {
        tx.write({ space, id, type, path: ["value", "count"] }, index);
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v1 extended tx sibling write x100",
  async () => {
    const storage = await seedV1Storage();
    try {
      const baseTx = createStorageTransaction(storage);
      const tx = new ExtendedStorageTransaction(baseTx);
      tx.write({ space, id, type, path: [] }, seedDocument);
      for (let index = 0; index < 100; index += 1) {
        tx.writeValueOrThrow({ space, id, type, path: ["count"] }, index);
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v2 transaction sibling write x100",
  async () => {
    const storage = await seedV2Storage();
    try {
      const tx = new V2StorageTransaction(storage);
      tx.write({ space, id, type, path: [] }, seedDocument);
      for (let index = 0; index < 100; index += 1) {
        tx.write({ space, id, type, path: ["value", "count"] }, index);
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v2 extended tx sibling write x100",
  async () => {
    const storage = await seedV2Storage();
    try {
      const baseTx = new V2StorageTransaction(storage);
      const tx = new ExtendedStorageTransaction(baseTx);
      tx.write({ space, id, type, path: [] }, seedDocument);
      for (let index = 0; index < 100; index += 1) {
        tx.writeValueOrThrow({ space, id, type, path: ["count"] }, index);
      }
    } finally {
      await storage.close();
    }
  },
);

Deno.bench(
  "Storage tx internals - v2 transaction direct writeWithinSpace sibling write x100",
  async () => {
    const storage = await seedV2Storage();
    try {
      const tx = new V2StorageTransaction(storage);
      tx.write({ space, id, type, path: [] }, seedDocument);
      const txInternal = tx as unknown as {
        writeWithinSpace(
          space: string,
          address: { id: string; type: string; path: string[] },
          value?: unknown,
        ): unknown;
      };
      for (let index = 0; index < 100; index += 1) {
        txInternal.writeWithinSpace(space, {
          id,
          type,
          path: ["value", "count"],
        }, index);
      }
    } finally {
      await storage.close();
    }
  },
);
