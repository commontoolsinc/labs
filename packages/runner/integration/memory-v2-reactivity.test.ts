#!/usr/bin/env -S deno run -A

import { assertEquals } from "@std/assert";
import app from "../../toolshed/app.ts";
import { Identity } from "@commontools/identity";
import { type JSONSchema, Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const waitFor = async (
  predicate: () => boolean,
  timeout = 5000,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const createRuntime = (identity: Identity, base: URL) =>
  new Runtime({
    apiUrl: base,
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", base),
      memoryVersion: "v2",
    }),
    memoryVersion: "v2",
  });

Deno.test("memory v2 runner discovers newly linked documents", async () => {
  const identity = await Identity.fromPassphrase(
    `runner-memory-v2-new-link-${Date.now()}`,
  );
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
  const space = identity.did();

  const addressSchema = {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
  } as const satisfies JSONSchema;

  const personSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: addressSchema,
    },
    required: ["name"],
  } as const satisfies JSONSchema;

  try {
    const runtime1 = createRuntime(identity, base);
    let tx = runtime1.edit();
    const addressCell = runtime1.getCell(
      space,
      "runner-v2-link-address",
      addressSchema,
      tx,
    );
    addressCell.set({ city: "San Francisco" });
    await tx.commit();

    tx = runtime1.edit();
    const personCell = runtime1.getCell(
      space,
      "runner-v2-link-person",
      personSchema,
      tx,
    );
    personCell.set({ name: "Alice" });
    await tx.commit();
    await runtime1.storageManager.synced();
    const addressLink = structuredClone(addressCell.getAsLink());
    await runtime1.dispose();

    const runtime2 = createRuntime(identity, base);
    const personCell2 = runtime2.getCell(
      space,
      "runner-v2-link-person",
      personSchema,
    );
    await personCell2.sync();
    await runtime2.storageManager.synced();
    assertEquals(personCell2.get()?.address, undefined);

    let receivedAddress = false;
    personCell2.sink((value) => {
      if (value?.address?.city === "San Francisco") {
        receivedAddress = true;
      }
    });

    const runtime3 = createRuntime(identity, base);
    const personCell3 = runtime3.getCell(
      space,
      "runner-v2-link-person",
      personSchema,
    );
    await personCell3.sync();
    tx = runtime3.edit();
    personCell3.withTx(tx).setRawUntyped({
      name: "Alice",
      address: addressLink,
    });
    await tx.commit();
    await runtime3.storageManager.synced();

    await waitFor(() => receivedAddress);
    assertEquals(personCell2.get(), {
      name: "Alice",
      address: { city: "San Francisco" },
    });

    await runtime3.dispose();
    await runtime2.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory v2 runner propagates linked document changes", async () => {
  const identity = await Identity.fromPassphrase(
    `runner-memory-v2-linked-update-${Date.now()}`,
  );
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
  const space = identity.did();

  const addressSchema = {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
  } as const satisfies JSONSchema;

  const personSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: addressSchema,
    },
    required: ["name", "address"],
  } as const satisfies JSONSchema;

  try {
    const runtime1 = createRuntime(identity, base);
    let tx = runtime1.edit();
    const addressCell = runtime1.getCell(
      space,
      "runner-v2-linked-address",
      addressSchema,
      tx,
    );
    addressCell.set({ city: "New York" });
    await tx.commit();
    await addressCell.sync();
    await runtime1.storageManager.synced();
    const addressLink = structuredClone(addressCell.getAsLink());

    tx = runtime1.edit();
    const personCell = runtime1.getCell(
      space,
      "runner-v2-linked-person",
      personSchema,
      tx,
    );
    personCell.setRawUntyped({
      name: "Bob",
      address: addressLink,
    });
    await tx.commit();
    await runtime1.storageManager.synced();
    await runtime1.dispose();

    const runtime2 = createRuntime(identity, base);
    const personCell2 = runtime2.getCell(
      space,
      "runner-v2-linked-person",
      personSchema,
    );
    await personCell2.sync();
    await runtime2.storageManager.synced();
    assertEquals(personCell2.get(), {
      name: "Bob",
      address: { city: "New York" },
    });

    let receivedNewCity = false;
    personCell2.sink((value) => {
      if (value?.address?.city === "Los Angeles") {
        receivedNewCity = true;
      }
    });

    const runtime3 = createRuntime(identity, base);
    const addressCell3 = runtime3.getCell(
      space,
      "runner-v2-linked-address",
      addressSchema,
    );
    await addressCell3.sync();
    tx = runtime3.edit();
    addressCell3.withTx(tx).set({ city: "Los Angeles" });
    await tx.commit();
    await runtime3.storageManager.synced();

    await waitFor(() => receivedNewCity);
    assertEquals(personCell2.get(), {
      name: "Bob",
      address: { city: "Los Angeles" },
    });

    await runtime3.dispose();
    await runtime2.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory v2 runner keeps deep linked chains live", async () => {
  const identity = await Identity.fromPassphrase(
    `runner-memory-v2-deep-link-${Date.now()}`,
  );
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
  const space = identity.did();

  const citySchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      population: { type: "number" },
    },
    required: ["name"],
  } as const satisfies JSONSchema;

  const addressSchema = {
    type: "object",
    properties: {
      street: { type: "string" },
      city: citySchema,
    },
    required: ["street", "city"],
  } as const satisfies JSONSchema;

  const personSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: addressSchema,
    },
    required: ["name", "address"],
  } as const satisfies JSONSchema;

  try {
    const runtime1 = createRuntime(identity, base);
    let tx = runtime1.edit();
    const cityCell = runtime1.getCell(
      space,
      "runner-v2-deep-city",
      citySchema,
      tx,
    );
    cityCell.set({ name: "Seattle", population: 750000 });
    await tx.commit();
    await cityCell.sync();
    await runtime1.storageManager.synced();
    const cityLink = structuredClone(cityCell.getAsLink());

    tx = runtime1.edit();
    const addressCell = runtime1.getCell(
      space,
      "runner-v2-deep-address",
      addressSchema,
      tx,
    );
    addressCell.setRawUntyped({
      street: "123 Main St",
      city: cityLink,
    });
    await tx.commit();
    await addressCell.sync();
    await runtime1.storageManager.synced();
    const addressLink = structuredClone(addressCell.getAsLink());

    tx = runtime1.edit();
    const personCell = runtime1.getCell(
      space,
      "runner-v2-deep-person",
      personSchema,
      tx,
    );
    personCell.setRawUntyped({
      name: "Charlie",
      address: addressLink,
    });
    await tx.commit();
    await runtime1.storageManager.synced();
    await runtime1.dispose();

    const runtime2 = createRuntime(identity, base);
    const personCell2 = runtime2.getCell(
      space,
      "runner-v2-deep-person",
      personSchema,
    );
    await personCell2.sync();
    await runtime2.storageManager.synced();
    assertEquals(personCell2.get(), {
      name: "Charlie",
      address: {
        street: "123 Main St",
        city: { name: "Seattle", population: 750000 },
      },
    });

    let receivedPopulation = false;
    personCell2.sink((value) => {
      if (value?.address?.city?.population === 800000) {
        receivedPopulation = true;
      }
    });

    const runtime3 = createRuntime(identity, base);
    const cityCell3 = runtime3.getCell(
      space,
      "runner-v2-deep-city",
      citySchema,
    );
    await cityCell3.sync();
    tx = runtime3.edit();
    cityCell3.withTx(tx).set({ name: "Seattle", population: 800000 });
    await tx.commit();
    await runtime3.storageManager.synced();

    await waitFor(() => receivedPopulation);
    assertEquals(personCell2.get(), {
      name: "Charlie",
      address: {
        street: "123 Main St",
        city: { name: "Seattle", population: 800000 },
      },
    });

    await runtime3.dispose();
    await runtime2.dispose();
  } finally {
    await server.shutdown();
  }
});
