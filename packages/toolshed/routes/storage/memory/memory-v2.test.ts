import { assert, assertEquals } from "@std/assert";
import app from "../../../app.ts";
import { MEMORY_V2_PROTOCOL } from "@commontools/memory/v2";
import { Identity } from "@commontools/identity";
import { Runtime, type JSONSchema } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const openSocket = async (url: URL): Promise<WebSocket> => {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(event), { once: true });
  });
  return socket;
};

const readJsonMessage = async <Message>(socket: WebSocket): Promise<Message> => {
  const payload = await new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        reject(new Error("Expected a string websocket message"));
        return;
      }
      resolve(event.data);
    }, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket error before message")),
      { once: true },
    );
  });

  return JSON.parse(payload) as Message;
};

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

Deno.test("memory websocket supports a runtime using the v2 cutover path", async () => {
  const identity = await Identity.fromPassphrase("memory-v2-route-traffic");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const storageManager = StorageManager.open({
      as: identity,
      address,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL(`http://${server.addr.hostname}:${server.addr.port}`),
      storageManager,
      memoryVersion: "v2",
    });
    const tx = runtime.edit();
    const cell = runtime.getCell(
      identity.did(),
      `memory-v2-toolshed-${Date.now()}`,
      undefined,
      tx,
    );

    cell.set({ hello: "world" });
    await tx.commit();
    await runtime.idle();

    const persisted = storageManager.open(identity.did()).get(
      cell.getAsNormalizedFullLink().id,
    );

    assertEquals(persisted?.value, { hello: "world" });

    await runtime.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket persists v2 runtime data across fresh runtimes", async () => {
  const identity = await Identity.fromPassphrase("memory-v2-route-persist");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
  const address = new URL("/api/storage/memory", base);
  const cause = `memory-v2-toolshed-persist-${Date.now()}`;

  try {
    const runtime1 = new Runtime({
      apiUrl: base,
      storageManager: StorageManager.open({
        as: identity,
        address,
        memoryVersion: "v2",
      }),
      memoryVersion: "v2",
    });
    const tx = runtime1.edit();
    const writer = runtime1.getCell(identity.did(), cause, undefined, tx);
    writer.set({ persisted: true, count: 1 });
    await tx.commit();
    await runtime1.idle();
    await runtime1.dispose();

    const runtime2 = new Runtime({
      apiUrl: base,
      storageManager: StorageManager.open({
        as: identity,
        address,
        memoryVersion: "v2",
      }),
      memoryVersion: "v2",
    });
    const reader = runtime2.getCell(identity.did(), cause);
    await reader.sync();
    await runtime2.storageManager.synced();

    assertEquals(reader.get(), { persisted: true, count: 1 });

    await runtime2.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket negotiates a v2 session", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address);
    socket.send(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));

    const message = await readJsonMessage<{
      type: "hello.ok";
      protocol: string;
    }>(socket);

    assertEquals(message.type, "hello.ok");
    assertEquals(message.protocol, MEMORY_V2_PROTOCOL);

    socket.send(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-toolshed-open",
      session: {},
    }));

    const opened = await readJsonMessage<{
      type: "response";
      requestId: string;
      ok: { sessionId: string; serverSeq: number };
    }>(socket);

    assertEquals(opened.type, "response");
    assertEquals(opened.requestId, "open-1");
    assertEquals(opened.ok.serverSeq, 0);
    assert(opened.ok.sessionId.length > 0);

    socket.close();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket resumes a requested v2 session id", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address);
    socket.send(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));

    await readJsonMessage(socket);

    socket.send(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-toolshed-resume",
      session: {
        sessionId: "session:test-resume",
        seenSeq: 7,
      },
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      ok: { sessionId: string; serverSeq: number };
    }>(socket);

    assertEquals(message.type, "response");
    assertEquals(message.requestId, "open-1");
    assertEquals(message.ok.sessionId, "session:test-resume");
    assertEquals(message.ok.serverSeq, 0);

    socket.close();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket requires hello before opening a v2 session", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address);
    socket.send(JSON.stringify({
      type: "session.open",
      requestId: "open-without-hello",
      space: "did:key:z6Mk-toolshed-no-hello",
      session: {},
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      error: { name: string; message: string };
    }>(socket);

    assertEquals(message.type, "response");
    assertEquals(message.requestId, "handshake");
    assertEquals(message.error.name, "ProtocolError");

    socket.close();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket discovers newly linked documents for a subscribed v2 runtime", async () => {
  const identity = await Identity.fromPassphrase(
    `memory-v2-new-link-${Date.now()}`,
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
    const addressCell = runtime1.getCell(space, "v2-link-address", addressSchema, tx);
    addressCell.set({ city: "San Francisco" });
    await tx.commit();

    tx = runtime1.edit();
    const personCell = runtime1.getCell(space, "v2-link-person", personSchema, tx);
    personCell.set({ name: "Alice" });
    await tx.commit();
    await runtime1.storageManager.synced();
    const addressEntityId = JSON.parse(JSON.stringify(addressCell.entityId));
    await runtime1.dispose();

    const runtime2 = createRuntime(identity, base);
    const personCell2 = runtime2.getCell(space, "v2-link-person", personSchema);
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
    const personCell3 = runtime3.getCell(space, "v2-link-person", personSchema);
    await personCell3.sync();
    tx = runtime3.edit();
    personCell3.withTx(tx).setRaw({
      name: "Alice",
      address: {
        "/": { "link@1": { id: `of:${addressEntityId["/"]}`, path: [] } },
      },
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

Deno.test("memory websocket propagates linked document changes to a subscribed v2 runtime", async () => {
  const identity = await Identity.fromPassphrase(
    `memory-v2-linked-update-${Date.now()}`,
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
    const addressCell = runtime1.getCell(space, "v2-linked-address", addressSchema, tx);
    addressCell.set({ city: "New York" });
    await tx.commit();
    await addressCell.sync();
    await runtime1.storageManager.synced();
    const addressEntityId = JSON.parse(JSON.stringify(addressCell.entityId));

    tx = runtime1.edit();
    const personCell = runtime1.getCell(space, "v2-linked-person", personSchema, tx);
    personCell.setRaw({
      name: "Bob",
      address: {
        "/": { "link@1": { id: `of:${addressEntityId["/"]}`, path: [] } },
      },
    });
    await tx.commit();
    await runtime1.storageManager.synced();
    await runtime1.dispose();

    const runtime2 = createRuntime(identity, base);
    const personCell2 = runtime2.getCell(space, "v2-linked-person", personSchema);
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
    const addressCell3 = runtime3.getCell(space, "v2-linked-address", addressSchema);
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

Deno.test("memory websocket keeps deep linked chains live for a subscribed v2 runtime", async () => {
  const identity = await Identity.fromPassphrase(
    `memory-v2-deep-link-${Date.now()}`,
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
    const cityCell = runtime1.getCell(space, "v2-deep-city", citySchema, tx);
    cityCell.set({ name: "Seattle", population: 750000 });
    await tx.commit();
    await cityCell.sync();
    await runtime1.storageManager.synced();
    const cityEntityId = JSON.parse(JSON.stringify(cityCell.entityId));

    tx = runtime1.edit();
    const addressCell = runtime1.getCell(space, "v2-deep-address", addressSchema, tx);
    addressCell.setRaw({
      street: "123 Main St",
      city: {
        "/": { "link@1": { id: `of:${cityEntityId["/"]}`, path: [] } },
      },
    });
    await tx.commit();
    await addressCell.sync();
    await runtime1.storageManager.synced();
    const addressEntityId = JSON.parse(JSON.stringify(addressCell.entityId));

    tx = runtime1.edit();
    const personCell = runtime1.getCell(space, "v2-deep-person", personSchema, tx);
    personCell.setRaw({
      name: "Charlie",
      address: {
        "/": { "link@1": { id: `of:${addressEntityId["/"]}`, path: [] } },
      },
    });
    await tx.commit();
    await runtime1.storageManager.synced();
    await runtime1.dispose();

    const runtime2 = createRuntime(identity, base);
    const personCell2 = runtime2.getCell(space, "v2-deep-person", personSchema);
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
    const cityCell3 = runtime3.getCell(space, "v2-deep-city", citySchema);
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

Deno.test("memory websocket re-establishes subscribed v2 runtimes after server restart", async () => {
  const identity = await Identity.fromPassphrase(
    `memory-v2-reconnect-runtime-${Date.now()}`,
  );
  let server = Deno.serve({ port: 0 }, app.fetch);
  const port = server.addr.port;
  const base = new URL(`http://${server.addr.hostname}:${port}`);
  const space = identity.did();

  const counterSchema = {
    type: "object",
    properties: {
      count: { type: "number" },
    },
    required: ["count"],
  } as const satisfies JSONSchema;

  try {
    const runtime1 = createRuntime(identity, base);
    let tx = runtime1.edit();
    const writer = runtime1.getCell(space, "v2-reconnect-counter", counterSchema, tx);
    writer.set({ count: 1 });
    await tx.commit();
    await runtime1.storageManager.synced();
    await runtime1.dispose();

    const subscriberRuntime = createRuntime(identity, base);
    const counterCell = subscriberRuntime.getCell(
      space,
      "v2-reconnect-counter",
      counterSchema,
    );
    await counterCell.sync();
    await subscriberRuntime.storageManager.synced();
    assertEquals(counterCell.get(), { count: 1 });

    let sawReconnectUpdate = false;
    counterCell.sink((value) => {
      if (value?.count === 2) {
        sawReconnectUpdate = true;
      }
    });

    await server.shutdown();
    server = Deno.serve({ port }, app.fetch);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const runtime2 = createRuntime(identity, base);
    const counterWriter = runtime2.getCell(space, "v2-reconnect-counter", counterSchema);
    await counterWriter.sync();
    tx = runtime2.edit();
    counterWriter.withTx(tx).set({ count: 2 });
    await tx.commit();
    await runtime2.storageManager.synced();

    await waitFor(() => sawReconnectUpdate);
    assertEquals(counterCell.get(), { count: 2 });

    await runtime2.dispose();
    await subscriberRuntime.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket round-trips alias schema metadata through synced v2 runtimes", async () => {
  const identity = await Identity.fromPassphrase(
    `memory-v2-alias-schema-${Date.now()}`,
  );
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
  const space = identity.did();

  const schema = {
    type: "object",
    properties: {
      count: { type: "number" },
      label: { type: "string" },
    },
  } as const satisfies JSONSchema;

  try {
    const runtime1 = createRuntime(identity, base);
    let tx = runtime1.edit();
    const targetCell = runtime1.getCell(space, "v2-alias-schema-target", undefined, tx);
    targetCell.set({ count: 42, label: "test" });

    const aliasCell = runtime1.getCell(space, "v2-alias-schema-source", undefined, tx);
    aliasCell.setRaw(
      targetCell.asSchema(schema).getAsWriteRedirectLink({ includeSchema: true }),
    );
    await tx.commit();
    await runtime1.storageManager.synced();
    await runtime1.dispose();

    const runtime2 = createRuntime(identity, base);
    const aliasCell2 = runtime2.getCell<{ count: number; label: string }>(
      space,
      "v2-alias-schema-source",
    );
    await aliasCell2.sync();
    await runtime2.storageManager.synced();
    assertEquals(aliasCell2.schema, schema);
    assertEquals(aliasCell2.key("count").schema, { type: "number" });
    assertEquals(aliasCell2.get(), { count: 42, label: "test" });

    await runtime2.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket preserves alias-derived schemas after v2 reconnect", async () => {
  const identity = await Identity.fromPassphrase(
    `memory-v2-alias-reconnect-${Date.now()}`,
  );
  let server = Deno.serve({ port: 0 }, app.fetch);
  const port = server.addr.port;
  const base = new URL(`http://${server.addr.hostname}:${port}`);
  const space = identity.did();

  const schema = {
    type: "object",
    properties: {
      count: { type: "number" },
      label: { type: "string" },
    },
  } as const satisfies JSONSchema;

  try {
    const runtime1 = createRuntime(identity, base);
    let tx = runtime1.edit();
    const targetCell = runtime1.getCell(space, "v2-alias-reconnect-target", undefined, tx);
    targetCell.set({ count: 1, label: "start" });
    const aliasCell = runtime1.getCell(space, "v2-alias-reconnect-source", undefined, tx);
    aliasCell.setRaw(
      targetCell.asSchema(schema).getAsWriteRedirectLink({ includeSchema: true }),
    );
    await tx.commit();
    await runtime1.storageManager.synced();
    await runtime1.dispose();

    const subscriberRuntime = createRuntime(identity, base);
    const aliasCell2 = subscriberRuntime.getCell<{ count: number; label: string }>(
      space,
      "v2-alias-reconnect-source",
    );
    await aliasCell2.sync();
    await subscriberRuntime.storageManager.synced();
    assertEquals(aliasCell2.schema, schema);
    assertEquals(aliasCell2.get(), { count: 1, label: "start" });

    let sawUpdate = false;
    aliasCell2.sink((value) => {
      if (value?.count === 2 && value?.label === "after-restart") {
        sawUpdate = true;
      }
    });

    await server.shutdown();
    server = Deno.serve({ port }, app.fetch);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const runtime2 = createRuntime(identity, base);
    const targetCell2 = runtime2.getCell(space, "v2-alias-reconnect-target");
    await targetCell2.sync();
    tx = runtime2.edit();
    targetCell2.withTx(tx).set({ count: 2, label: "after-restart" });
    await tx.commit();
    await runtime2.storageManager.synced();

    await waitFor(() => sawUpdate);
    assertEquals(aliasCell2.schema, schema);
    assertEquals(aliasCell2.key("count").schema, { type: "number" });
    assertEquals(aliasCell2.get(), { count: 2, label: "after-restart" });

    await runtime2.dispose();
    await subscriberRuntime.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket keeps retargeted aliases live for subscribed v2 runtimes", async () => {
  const identity = await Identity.fromPassphrase(
    `memory-v2-alias-retarget-${Date.now()}`,
  );
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
  const space = identity.did();

  const schema = {
    type: "object",
    properties: {
      count: { type: "number" },
      label: { type: "string" },
    },
  } as const satisfies JSONSchema;

  try {
    const runtime1 = createRuntime(identity, base);
    let tx = runtime1.edit();
    const firstTarget = runtime1.getCell(space, "v2-alias-retarget-first", undefined, tx);
    firstTarget.set({ count: 1, label: "first" });
    const secondTarget = runtime1.getCell(space, "v2-alias-retarget-second", undefined, tx);
    secondTarget.set({ count: 2, label: "second" });
    const aliasCell = runtime1.getCell(space, "v2-alias-retarget-source", undefined, tx);
    aliasCell.setRaw(
      firstTarget.asSchema(schema).getAsWriteRedirectLink({ includeSchema: true }),
    );
    await tx.commit();
    await runtime1.storageManager.synced();

    const subscriberRuntime = createRuntime(identity, base);
    const aliasCell2 = subscriberRuntime.getCell<{ count: number; label: string }>(
      space,
      "v2-alias-retarget-source",
    );
    await aliasCell2.sync();
    await subscriberRuntime.storageManager.synced();
    assertEquals(aliasCell2.get(), { count: 1, label: "first" });

    let sawRetarget = false;
    aliasCell2.sink((value) => {
      if (value?.count === 2 && value?.label === "second") {
        sawRetarget = true;
      }
    });

    tx = runtime1.edit();
    aliasCell.withTx(tx).setRaw(
      secondTarget.asSchema(schema).getAsWriteRedirectLink({ includeSchema: true }),
    );
    await tx.commit();
    await runtime1.storageManager.synced();

    await waitFor(() => sawRetarget);
    assertEquals(aliasCell2.schema, schema);
    assertEquals(aliasCell2.get(), { count: 2, label: "second" });

    await subscriberRuntime.dispose();
    await runtime1.dispose();
  } finally {
    await server.shutdown();
  }
});
