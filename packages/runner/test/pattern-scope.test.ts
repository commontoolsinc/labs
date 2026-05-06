import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink, toMemorySpaceAddress } from "../src/link-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { createCell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

Deno.test("pattern factory .asScope() sets child pattern result scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern(() => ({ value: "child" }));
    const Root = pattern(() => ({
      child: Child.asScope("user")({}),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern factory asScope child result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const childLink = parseLink(result.key("child").getRaw(), result);
    assertEquals(childLink?.scope, "user");
    assertEquals(
      runtime.getCellFromLink(childLink!).getSourceCell()
        ?.getAsNormalizedFullLink().scope,
      "user",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern result schema scope overrides factory .asScope()", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern(
      () => ({ value: "child" }),
      { type: "object", properties: {} },
      {
        type: "object",
        properties: { value: { type: "string" } },
        scope: "session",
      },
    );
    const Root = pattern(() => ({
      child: Child.asScope("user")({}),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern result schema scope override",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    await result.pull();

    const childLink = parseLink(result.key("child").getRaw(), result);
    assertEquals(childLink?.scope, "session");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("runtime rejects inherit scope on full normalized links", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    assertEquals(
      (() => {
        try {
          runtime.getCellFromLink({
            id: "of:unresolved-inherit-scope",
            space,
            scope: "inherit",
            path: [],
          } as any);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })(),
      "NormalizedFullLink.scope cannot be 'inherit'; resolve scope before creating a full link",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("cross-space scoped links preserve target space and resolved scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const otherSigner = await Identity.fromPassphrase(
    "cross-space scoped link target",
  );
  const targetSpace = otherSigner.did();

  try {
    const setupTx = runtime.edit();
    const baseTarget = runtime.getCell<string>(
      targetSpace,
      "cross-space user scoped target",
      undefined,
      setupTx,
    );
    const target = createCell<string>(
      runtime,
      { ...baseTarget.getAsNormalizedFullLink(), scope: "user" },
      setupTx,
    );
    target.set("target value");
    await setupTx.commit();

    const source = runtime.getCell<{ linked?: unknown }>(
      space,
      "cross-space scoped link source",
      undefined,
      tx,
    );
    source.set({ linked: target.getAsLink({ base: source.key("linked") }) });

    const resolved = parseLink(
      source.key("linked").getRaw(),
      source.key("linked"),
    );
    assertEquals(resolved?.space, targetSpace);
    assertEquals(resolved?.scope, "user");
    assertEquals(toMemorySpaceAddress(resolved!).space, targetSpace);
    assertEquals(toMemorySpaceAddress(resolved!).scope, "user");
    assertEquals(source.key("linked").get(), "target value");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("broad computed output links to narrower scoped result", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const baseSecret = runtime.getCell<number>(
      space,
      "user scoped computation input",
      undefined,
      tx,
    );
    const secret = createCell(
      runtime,
      { ...baseSecret.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    secret.set(41);

    const Root = pattern<{ secret: number }>(({ secret }) => ({
      value: lift(
        { type: "number" },
        { type: "number" },
        (x: number) => x + 1,
      )(secret),
    }));

    const resultCell = runtime.getCell(
      space,
      "broad computed output links to narrower scoped result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { secret }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const sourceCell = result.getSourceCell();
    const rawValue = sourceCell?.key("internal").key("value").getRaw();
    const valueLink = parseLink(rawValue, sourceCell!);
    assertEquals(valueLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, 42);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("opaque JS action result uses narrowest effective output scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { computed, lift, pattern } =
      createTrustedBuilder(runtime).commonfabric;
    const baseSecret = runtime.getCell<number>(
      space,
      "opaque user scoped computation input",
      undefined,
      tx,
    );
    const secret = createCell(
      runtime,
      { ...baseSecret.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    secret.set(41);

    const structured = lift(
      { type: "number" },
      {
        type: "object",
        properties: { nested: { type: "number" } },
      },
      (_x: number) => ({
        nested: computed(() => 42),
      }),
    );
    const Root = pattern<{ secret: number }>(({ secret }) => ({
      value: structured(secret),
    }));

    const resultCell = runtime.getCell(
      space,
      "opaque action result links to narrower scoped result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { secret }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const sourceCell = result.getSourceCell();
    const rawValue = sourceCell?.key("internal").key("value").getRaw();
    const outputLink = parseLink(rawValue, sourceCell!);
    assertEquals(outputLink?.scope, "user");

    const scopedOutputCell = runtime.getCellFromLink(outputLink!);
    const auxiliaryLink = parseLink(
      scopedOutputCell.getRaw(),
      scopedOutputCell,
    );
    assertEquals(auxiliaryLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, { nested: 42 });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("opaque JS action result schema scope participates in effective output scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { computed, lift, pattern } =
      createTrustedBuilder(runtime).commonfabric;
    const structured = lift(
      { type: "number" },
      {
        type: "object",
        properties: { nested: { type: "number" } },
        scope: "session",
      },
      (_x: number) => ({
        nested: computed(() => 42),
      }),
    );
    const Root = pattern<{ value: number }>(({ value }) => ({
      value: structured(value),
    }));

    const resultCell = runtime.getCell(
      space,
      "opaque action result schema scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { value: 41 }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const sourceCell = result.getSourceCell();
    const rawValue = sourceCell?.key("internal").key("value").getRaw();
    const outputLink = parseLink(rawValue, sourceCell!);
    assertEquals(outputLink?.scope, "session");

    const scopedOutputCell = runtime.getCellFromLink(outputLink!);
    const auxiliaryLink = parseLink(
      scopedOutputCell.getRaw(),
      scopedOutputCell,
    );
    assertEquals(auxiliaryLink?.scope, "session");
    assertEquals(result.key("value").get() as unknown, { nested: 42 });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map keeps outer list scope and narrows per-element result cells", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "map scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const increment = lift(
      { type: "number" },
      { type: "number" },
      (x: number) => x + 1,
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      mapped: values.map((value) => increment(value)),
    }));

    const resultCell = runtime.getCell(
      space,
      "map keeps outer list scope and narrows per-element result cells",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawMapped = result.key("mapped").getRaw();
    const mappedLink = parseLink(rawMapped, result);
    assertEquals(mappedLink?.scope, "space");

    const mappedResultCell = runtime.getCellFromLink(mappedLink!);
    const mappedRaw = mappedResultCell.getRaw();
    const itemLink = Array.isArray(mappedRaw)
      ? parseLink(mappedRaw[0], mappedResultCell)
      : undefined;
    assertEquals(itemLink?.scope, "user");
    assertEquals(runtime.getCellFromLink(itemLink!).getRaw(), 21);
    assertEquals(result.key("mapped").get() as unknown, [21]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("filter narrows output list when scoped element controls cardinality", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "filter scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const positive = lift(
      { type: "number" },
      { type: "boolean" },
      (x: number) => x > 0,
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      filtered: values.filter((value) => positive(value)),
    }));

    const resultCell = runtime.getCell(
      space,
      "filter narrows output list when scoped element controls cardinality",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawFiltered = result.key("filtered").getRaw();
    const filteredLink = parseLink(rawFiltered, result);
    assertEquals(filteredLink?.scope, "user");
    assertEquals(result.key("filtered").get() as unknown, [20]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("flatMap narrows output list when scoped element controls cardinality", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "flatMap scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const expand = lift(
      { type: "number" },
      { type: "array", items: { type: "number" } },
      (x: number) => [x, x + 1],
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      expanded: values.flatMap((value) => expand(value)),
    }));

    const resultCell = runtime.getCell(
      space,
      "flatMap narrows output list when scoped element controls cardinality",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawExpanded = result.key("expanded").getRaw();
    const expandedLink = parseLink(rawExpanded, result);
    assertEquals(expandedLink?.scope, "user");
    assertEquals(result.key("expanded").get() as unknown, [20, 21]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("ifElse output follows condition scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { ifElse, pattern } = createTrustedBuilder(runtime).commonfabric;
    const conditionBase = runtime.getCell<boolean>(
      space,
      "ifElse user scoped condition",
      undefined,
      tx,
    );
    const condition = createCell<boolean>(
      runtime,
      { ...conditionBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    condition.set(true);

    const Root = pattern<{ condition: boolean }>(({ condition }) => ({
      value: ifElse(condition, "yes", "no"),
    }));

    const resultCell = runtime.getCell(
      space,
      "ifElse output follows condition scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { condition }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawValue = result.key("value").getRaw();
    const valueLink = parseLink(rawValue, result);
    assertEquals(valueLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, "yes");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("session scoped derived chains update when broad inputs change", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  type RoomId = "lobby" | "workshop";
  type Conversation = {
    rooms: Record<RoomId, { body: string }[]>;
  };

  try {
    const { ifElse, lift, pattern } = createTrustedBuilder(runtime)
      .commonfabric;
    const conversationSchema = {
      type: "object",
      properties: {
        rooms: {
          type: "object",
          properties: {
            lobby: {
              type: "array",
              items: {
                type: "object",
                properties: { body: { type: "string" } },
                required: ["body"],
              },
            },
            workshop: {
              type: "array",
              items: {
                type: "object",
                properties: { body: { type: "string" } },
                required: ["body"],
              },
            },
          },
          required: ["lobby", "workshop"],
        },
      },
      required: ["rooms"],
    } as const;
    const messageListSchema = {
      type: "array",
      items: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
      },
    } as const;
    const selectMessages = lift(
      {
        type: "object",
        properties: {
          conversation: conversationSchema,
          room: { enum: ["lobby", "workshop"] },
        },
        required: ["conversation", "room"],
      } as const,
      messageListSchema,
      (
        { conversation, room }: {
          conversation: Conversation;
          room: RoomId;
        },
      ) => conversation.rooms[room] ?? [],
    );
    const countMessages = lift(
      messageListSchema,
      { type: "number" } as const,
      (messages: { body: string }[]) => messages.length,
    );
    const countLobby = lift(
      conversationSchema,
      { type: "number" } as const,
      (conversation: Conversation) => conversation.rooms.lobby.length,
    );
    const isZero = lift(
      { type: "number" } as const,
      { type: "boolean" } as const,
      (count: number) => count === 0,
    );
    const conversation = runtime.getCell<Conversation>(
      space,
      "session derived chain broad conversation",
      undefined,
      tx,
    );
    conversation.set({ rooms: { lobby: [], workshop: [] } });

    const roomBase = runtime.getCell<RoomId>(
      space,
      "session derived chain room",
      undefined,
      tx,
    );
    const room = createCell<RoomId>(
      runtime,
      { ...roomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    room.set("lobby");

    const Root = pattern<{
      conversation: Conversation;
      room: RoomId;
    }>(({ conversation, room }) => {
      const messages = selectMessages({ conversation, room });
      const messageCount = countMessages(messages);
      const isEmpty = isZero(messageCount);

      return {
        lobbyCount: countLobby(conversation),
        messageCount,
        isEmpty,
        branch: ifElse(isEmpty, "empty", "messages"),
      };
    });

    const resultCell = runtime.getCell(
      space,
      "session derived chain result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      Root,
      { conversation, room },
      resultCell,
    );
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("lobbyCount").get() as unknown, 0);
    assertEquals(result.key("messageCount").get() as unknown, 0);
    assertEquals(result.key("isEmpty").get() as unknown, true);
    assertEquals(result.key("branch").get() as unknown, "empty");

    const updateTx = runtime.edit();
    conversation.withTx(updateTx).set({
      rooms: { lobby: [{ body: "hello" }], workshop: [] },
    });
    await updateTx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("lobbyCount").get() as unknown, 1);
    assertEquals(result.key("messageCount").get() as unknown, 1);
    assertEquals(result.key("isEmpty").get() as unknown, false);
    assertEquals(result.key("branch").get() as unknown, "messages");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("when keeps condition scope while selecting narrower value link", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, when } = createTrustedBuilder(runtime).commonfabric;
    const valueBase = runtime.getCell<string>(
      space,
      "when user scoped selected value",
      undefined,
      tx,
    );
    const value = createCell<string>(
      runtime,
      { ...valueBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    value.set("selected");

    const Root = pattern<{ value: string }>(({ value }) => ({
      value: when(true, value),
    }));

    const resultCell = runtime.getCell(
      space,
      "when keeps condition scope while selecting narrower value link",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { value }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawValue = result.key("value").getRaw();
    const whenLink = parseLink(rawValue, result);
    assertEquals(whenLink?.scope, "space");

    const whenCell = runtime.getCellFromLink(whenLink!);
    const selectedLink = parseLink(whenCell.getRaw(), whenCell);
    assertEquals(selectedLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, "selected");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("fetchData state cells use narrowest input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { fetchData, pattern } = createTrustedBuilder(runtime).commonfabric;
    const urlBase = runtime.getCell<string>(
      space,
      "fetchData user scoped url",
      undefined,
      tx,
    );
    const url = createCell<string>(
      runtime,
      { ...urlBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    url.set("");

    const Root = pattern<{ url: string }>(({ url }) => fetchData({ url }));

    const resultCell = runtime.getCell(
      space,
      "fetchData state cells use narrowest input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { url }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const pendingLink = parseLink(result.key("pending").getRaw(), result);
    const resultLink = parseLink(result.key("result").getRaw(), result);
    const errorLink = parseLink(result.key("error").getRaw(), result);
    assertEquals(pendingLink?.scope, "user");
    assertEquals(resultLink?.scope, "user");
    assertEquals(errorLink?.scope, "user");
    assertEquals(result.key("pending").get() as unknown, false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("generateText result cell uses narrowest input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { generateText, pattern } = createTrustedBuilder(runtime)
      .commonfabric;
    const promptBase = runtime.getCell<string>(
      space,
      "generateText user scoped empty prompt",
      undefined,
      tx,
    );
    const prompt = createCell<string>(
      runtime,
      { ...promptBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    prompt.set("");

    const Root = pattern<{ prompt: string }>(({ prompt }) => ({
      text: generateText({ prompt }),
    }));

    const resultCell = runtime.getCell(
      space,
      "generateText result cell uses narrowest input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { prompt }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawText = result.key("text").getRaw();
    const textLink = parseLink(rawText, result);
    assertEquals(textLink?.scope, "user");
    assertEquals(result.key("text").key("pending").get() as unknown, false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("llmDialog result cell uses narrowest input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, llmDialog } = createTrustedBuilder(runtime).commonfabric;

    const messagesBase = runtime.getCell<any[]>(
      space,
      "llmDialog user scoped messages",
      undefined,
      tx,
    );
    const messages = createCell<any[]>(
      runtime,
      { ...messagesBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    messages.set([]);

    const Root = pattern<{ messages: any[] }>(({ messages }) => ({
      dialog: llmDialog({ messages }),
    }));

    const resultCell = runtime.getCell(
      space,
      "llmDialog result cell uses narrowest input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { messages }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawDialog = result.key("dialog").getRaw();
    const dialogLink = parseLink(rawDialog, result);
    assertEquals(dialogLink?.scope, "user");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("wish current-space output follows query input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, wish } = createTrustedBuilder(runtime).commonfabric;

    const spaceCell = runtime.getCell(space, space, undefined, tx);
    spaceCell.key("config").set({ value: "scoped" });

    const queryBase = runtime.getCell<string>(
      space,
      "wish user scoped current-space query",
      undefined,
      tx,
    );
    const query = createCell<string>(
      runtime,
      { ...queryBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    query.set("/config");

    const Root = pattern<{ query: string }>(({ query }) => ({
      found: wish({ query }),
    }));

    const resultCell = runtime.getCell(
      space,
      "wish current-space output follows query input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { query }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const foundLink = parseLink(result.key("found").getRaw(), result);
    assertEquals(foundLink?.scope, "user");
    assertEquals(result.key("found").key("result").get() as unknown, {
      value: "scoped",
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("wish home-space output is at least user scoped", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, wish } = createTrustedBuilder(runtime).commonfabric;

    const homeSpaceCell = runtime.getHomeSpaceCell(tx);
    const defaultPatternCell = runtime.getCell(
      space,
      "wish home scoped default pattern",
      undefined,
      tx,
    );
    const favoriteItem = runtime.getCell(
      space,
      "wish home scoped favorite item",
      undefined,
      tx,
    );
    favoriteItem.set({ name: "Favorite" });
    defaultPatternCell.key("favorites").set([
      { cell: favoriteItem, tag: "#favorite" },
    ]);
    homeSpaceCell.key("defaultPattern").set(defaultPatternCell);

    const Root = pattern(() => ({
      favorites: wish({ query: "#favorites" }),
    }));

    const resultCell = runtime.getCell(
      space,
      "wish home-space output is at least user scoped",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const favoritesLink = parseLink(result.key("favorites").getRaw(), result);
    assertEquals(favoritesLink?.scope, "user");
    assertEquals(
      result.key("favorites").key("result").get() as unknown,
      [{ cell: favoriteItem.get(), tag: "#favorite" }],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("wish result schema scope overrides query-derived scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, wish } = createTrustedBuilder(runtime).commonfabric;

    const spaceCell = runtime.getCell(space, space, undefined, tx);
    spaceCell.key("sessionConfig").set({ value: "scoped" });

    const queryBase = runtime.getCell<string>(
      space,
      "wish schema scoped current-space query",
      undefined,
      tx,
    );
    const query = createCell<string>(
      runtime,
      { ...queryBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    query.set("/sessionConfig");

    const Root = pattern<{ query: string }>(({ query }) => ({
      found: wish({
        query,
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          scope: "session",
        },
      }),
    }));

    const resultCell = runtime.getCell(
      space,
      "wish result schema scope overrides query-derived scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { query }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const foundLink = parseLink(result.key("found").getRaw(), result);
    assertEquals(foundLink?.scope, "session");
    assertEquals(result.key("found").key("result").get() as unknown, {
      value: "scoped",
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
