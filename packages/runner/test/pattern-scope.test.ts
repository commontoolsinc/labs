import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  getMetaLink,
  parseLink,
  toMemorySpaceAddress,
} from "../src/link-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Cell, createCell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

Deno.test("Cell.key preserves link scope when child schema sets a follow cap", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const cell = runtime.getCell(
      space,
      "schema scoped child key",
      {
        type: "object",
        properties: {
          name: { type: "string", scope: "user" },
          selectedRoom: {
            type: "object",
            scope: "session",
            properties: {
              room: { type: "string" },
            },
          },
        },
      },
      tx,
    );

    assertEquals(cell.getAsNormalizedFullLink().scope, "space");
    assertEquals(cell.key("name").getAsNormalizedFullLink().scope, "space");
    assertEquals(
      cell.key("selectedRoom").getAsNormalizedFullLink().scope,
      "space",
    );
    assertEquals(
      cell.key("selectedRoom", "room").getAsNormalizedFullLink().scope,
      "space",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("Cell.key reads a stored broader link when child schema is scoped", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const sessionTargetBase = runtime.getCell<string | null>(
      space,
      "schema scoped child stored link target",
      undefined,
      tx,
    );
    const sessionTarget = createCell<string | null>(
      runtime,
      { ...sessionTargetBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    sessionTarget.set("a");

    const cell = runtime.getCell(
      space,
      "schema scoped child stored link root",
      {
        type: "object",
        properties: {
          sessionTarget: {
            anyOf: [{ type: "string" }, { type: "null" }],
            scope: "session",
          },
        },
        required: ["sessionTarget"],
      },
      tx,
    );
    cell.setRawUntyped({
      sessionTarget: sessionTarget.getAsLink({ base: cell }),
    });

    const sessionTargetKey = cell.key("sessionTarget");
    const stored = parseLink(
      sessionTargetKey.getRawUntyped(),
      sessionTargetKey as Cell<unknown>,
    )!;
    assertEquals(stored.id, sessionTarget.getAsNormalizedFullLink().id);
    assertEquals(stored.scope, "session");
    assertEquals(cell.key("sessionTarget").get(), "a");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("handler bindings preserve scoped cells selected from pattern input schema", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;

    interface Conversation {
      rooms: { name: string }[];
    }

    const addRoom = handler<
      { name?: string },
      { conversation: Cell<Conversation>; newRoomName: Cell<string> }
    >({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    }, {
      type: "object",
      properties: {
        conversation: {
          type: "object",
          properties: {
            rooms: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
              default: [],
            },
          },
          required: ["rooms"],
          default: { rooms: [] },
          asCell: ["cell"],
        },
        newRoomName: {
          type: "string",
          default: "",
          asCell: ["cell"],
        },
      },
      required: ["conversation", "newRoomName"],
    }, ({ name: eventName }, { conversation, newRoomName }) => {
      const name = eventName ?? newRoomName.get();
      if (!name) return;
      conversation.key("rooms").push({ name });
      newRoomName.set("");
    });

    const Root = pattern<{
      conversation: Conversation;
      newRoomName: string;
    }>(({ conversation, newRoomName }) => ({
      conversation,
      newRoomName,
      addRoom: addRoom({
        conversation: conversation as unknown as Cell<Conversation>,
        newRoomName: newRoomName as unknown as Cell<string>,
      }),
    }), {
      type: "object",
      properties: {
        conversation: {
          type: "object",
          scope: "space",
          properties: {
            rooms: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
              default: [],
            },
          },
          required: ["rooms"],
          default: { rooms: [] },
        },
        newRoomName: {
          type: "string",
          default: "",
          scope: "session",
        },
      },
      required: ["conversation", "newRoomName"],
    });

    const resultCell = runtime.getCell(
      space,
      "handler scoped pattern input binding",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      conversation: { rooms: [] },
      newRoomName: "",
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const setTx = runtime.edit();
    result.key("newRoomName").withTx(setTx).set("Project");
    runtime.prepareTxForCommit(setTx);
    await setTx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    result.key("addRoom").send({});
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("conversation").get(), {
      rooms: [{ name: "Project" }],
    });
    assertEquals(result.key("newRoomName").get() as unknown, "");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("per-user pointer can create and update a space-scoped profile cell", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { handler, pattern, Writable } =
      createTrustedBuilder(runtime).commonfabric;

    interface Profile {
      name: string;
    }

    interface MyProfile {
      profile?: Cell<Profile>;
    }

    interface Message {
      authorName: string;
      authorProfile: Cell<Profile>;
      body: string;
    }

    const profileSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    } as const;
    const myProfileSchema = {
      type: "object",
      properties: {
        profile: {
          ...profileSchema,
          asCell: [{ kind: "cell", scope: "space" }],
        },
      },
      default: {},
    } as const;
    const messagesSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          authorName: { type: "string" },
          authorProfile: {
            ...profileSchema,
            asCell: [{ kind: "cell", scope: "space" }],
          },
          body: { type: "string" },
        },
        required: ["authorName", "authorProfile", "body"],
      },
      default: [],
    } as const;

    const saveName = handler<
      { name: string },
      { myProfile: Cell<MyProfile> }
    >({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    }, {
      type: "object",
      properties: {
        myProfile: {
          ...myProfileSchema,
          asCell: [{ kind: "cell", scope: "user" }],
        },
      },
      required: ["myProfile"],
    }, ({ name }, { myProfile }) => {
      const existing = myProfile.get()?.profile;
      if (existing?.get()) {
        existing.key("name").set(name);
        return;
      }

      const profile = Writable.for<Profile>("profile");
      profile.set({ name });
      myProfile.set({ profile });
    });

    const sendMessage = handler<
      { body: string },
      { myProfile: Cell<MyProfile>; messages: Cell<Message[]> }
    >({
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
    }, {
      type: "object",
      properties: {
        myProfile: {
          ...myProfileSchema,
          asCell: [{ kind: "cell", scope: "user" }],
        },
        messages: {
          ...messagesSchema,
          asCell: [{ kind: "cell", scope: "space" }],
        },
      },
      required: ["myProfile", "messages"],
    }, ({ body }, { myProfile, messages }) => {
      const profile = myProfile.get()?.profile;
      if (!profile?.get()) {
        return;
      }

      messages.push({
        authorName: profile.key("name").get(),
        authorProfile: profile,
        body,
      });
    });

    const Root = pattern<{
      myProfile: MyProfile;
      messages: Message[];
    }>(({ myProfile, messages }) => ({
      myProfile,
      messages,
      saveName: saveName(
        ({
          myProfile: myProfile as unknown as Cell<MyProfile>,
        }) as any,
      ),
      sendMessage: sendMessage(
        ({
          myProfile: myProfile as unknown as Cell<MyProfile>,
          messages: messages as unknown as Cell<Message[]>,
        }) as any,
      ),
    }), {
      type: "object",
      properties: {
        myProfile: {
          ...myProfileSchema,
          scope: "user",
        },
        messages: {
          ...messagesSchema,
          scope: "space",
        },
      },
      required: ["myProfile", "messages"],
    });

    const resultCell = runtime.getCell(
      space,
      "scoped profile pointer creation",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      myProfile: {},
      messages: [],
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    result.key("saveName").send({ name: "Ada" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const myProfileCell = result.key("myProfile").resolveAsCell();
    assertEquals(myProfileCell.getAsNormalizedFullLink().scope, "user");
    const profileCell = myProfileCell.asSchema<MyProfile>(myProfileSchema)
      .get().profile;
    if (!profileCell) {
      throw new Error("expected profile cell");
    }
    assertEquals(profileCell.getAsNormalizedFullLink().scope, "space");
    assertEquals(profileCell.get(), { name: "Ada" });
    const firstProfileRef = profileCell.getAsNormalizedFullLink();

    result.key("saveName").send({ name: "Ada Byron" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const updatedProfileCell = myProfileCell.asSchema<MyProfile>(
      myProfileSchema,
    ).get().profile;
    if (!updatedProfileCell) {
      throw new Error("expected updated profile cell");
    }
    assertEquals(
      updatedProfileCell.getAsNormalizedFullLink().id,
      firstProfileRef.id,
    );
    assertEquals(updatedProfileCell.getAsNormalizedFullLink().scope, "space");
    assertEquals(updatedProfileCell.get(), { name: "Ada Byron" });

    result.key("sendMessage").send({ body: "hello" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const messagesCell = result.key("messages").resolveAsCell();
    const message = messagesCell.asSchema<Message[]>(messagesSchema).get()[0];
    assertEquals(message.authorName, "Ada Byron");
    assertEquals(message.body, "hello");
    assertEquals(
      message.authorProfile.getAsNormalizedFullLink().id,
      firstProfileRef.id,
    );
    assertEquals(
      message.authorProfile.getAsNormalizedFullLink().scope,
      "space",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern node input schema preserves explicit cell arguments", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { derive, handler, pattern, Writable } =
      createTrustedBuilder(runtime).commonfabric;

    const profilesSchema = {
      type: "array",
      items: { type: "string" },
      default: [],
    } as const;
    const profilesCellSchema = {
      ...profilesSchema,
      asCell: [{ kind: "cell", scope: "space" }],
    } as const;

    const addProfile = handler<
      { name: string },
      { profiles: Cell<string[]> }
    >({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    }, {
      type: "object",
      properties: { profiles: profilesCellSchema },
      required: ["profiles"],
    }, ({ name }, { profiles }) => {
      profiles.set([...profiles.get(), name]);
    });

    const Child = pattern<{
      profiles: Cell<string[]>;
    }>(({ profiles }) => ({
      addProfile: addProfile({ profiles }),
    }), {
      type: "object",
      properties: { profiles: profilesCellSchema },
      required: ["profiles"],
    });

    const Root = pattern(() => {
      const profiles = Writable.of<string[]>([], profilesSchema).for(
        "profiles",
        true,
      );
      const child = Child({ profiles });
      return {
        profiles,
        addProfile: child.addProfile,
        hasBob: derive(
          profiles,
          (profiles) => (profiles as unknown as string[]).includes("Bob"),
        ),
      };
    });

    const resultCell = runtime.getCell(
      space,
      "pattern node explicit cell input binding",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    result.key("addProfile").send({ name: "Bob" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("profiles").get(), ["Bob"]);
    assertEquals(result.key("hasBob").get() as unknown, true);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

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

    const childLink = parseLink(
      result.key("child").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
    assertEquals(childLink?.scope, "user");
    assertEquals(
      runtime.getCellFromLink(childLink!)?.getAsNormalizedFullLink().scope,
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

    const childLink = parseLink(
      result.key("child").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
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

    const internalLink = getMetaLink(result, "internal");
    const internalCell = runtime.getCellFromLink(internalLink!);
    // in this case, don't follow links before the getRaw, because the links
    // take us all the way to the value, and then we can't see the scope
    const rawValue = internalCell?.key("value").getRaw();
    const valueLink = parseLink(rawValue, internalCell!);
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

    const internalLink = getMetaLink(result, "internal");
    const internalCell = runtime.getCellFromLink(internalLink!);
    const rawValue = internalCell.key("value").getRaw();
    const outputLink = parseLink(rawValue, internalCell!);
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

    const internalLink = getMetaLink(result, "internal");
    const internalCell = runtime.getCellFromLink(internalLink!);
    const rawValue = internalCell?.key("value").getRaw();
    const outputLink = parseLink(rawValue, internalCell!);
    assertEquals(outputLink?.scope, "session");

    const scopedOutputCell = runtime.getCellFromLink(outputLink!);
    const auxiliaryLink = parseLink(
      scopedOutputCell.key("nested").getRaw(),
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
    // For this, follow all the way through to the value
    // We have a non-redirect link in that chain, and we need the value anyhow
    const mappedRaw = mappedResultCell.getRaw({
      lastNode: "value",
    });
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

Deno.test("lift can read session-scoped cell passed from pattern input", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const sessionTargetBase = runtime.getCell<string | null>(
      space,
      "lift captured session target",
      undefined,
      tx,
    );
    const sessionTarget = createCell<string | null>(
      runtime,
      { ...sessionTargetBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    sessionTarget.set("a");
    const sessionTargetBaseLink = sessionTargetBase.getAsNormalizedFullLink();
    const sessionTargetLink = sessionTarget.getAsNormalizedFullLink();
    assertEquals(sessionTargetBaseLink.scope, "space");
    assertEquals(sessionTargetLink, {
      ...sessionTargetBaseLink,
      scope: "session",
    });
    assertEquals(sessionTarget.get(), "a");

    const inputSchema = {
      type: "object",
      properties: {
        sessionTarget: {
          anyOf: [{ type: "string" }, { type: "null" }],
          asCell: [{ kind: "cell", scope: "session" }],
        },
      },
      required: ["sessionTarget"],
    } as const;

    const isSessionOpen = lift(
      {
        type: "object",
        properties: {
          sessionTarget: {
            anyOf: [{ type: "string" }, { type: "null" }],
            asCell: [{ kind: "cell", scope: "session" }],
          },
          id: { type: "string" },
        },
        required: ["sessionTarget", "id"],
      },
      { type: "boolean" },
      (
        { sessionTarget, id }: {
          sessionTarget: Cell<string | null>;
          id: string;
        },
      ) => sessionTarget.get() === id,
    );

    const Root = pattern<{
      sessionTarget: Cell<string | null>;
    }>(({ sessionTarget }) => ({
      isOpen: isSessionOpen({
        sessionTarget,
        id: "a",
      }),
    }), inputSchema);

    const resultCell = runtime.getCell(
      space,
      "lift reads session scoped cell passed from pattern input",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      sessionTarget,
    }, resultCell);
    const argumentCell = runtime.getCellFromLink(
      getMetaLink(result, "argument")!,
      undefined,
      tx,
    );
    const argumentSessionTarget = argumentCell.key("sessionTarget");
    const storedArgumentTargetLink = parseLink(
      argumentSessionTarget.getRawUntyped(),
      argumentSessionTarget,
    )!;
    assertEquals(storedArgumentTargetLink.id, sessionTargetLink.id);
    assertEquals(storedArgumentTargetLink.path, sessionTargetLink.path);
    assertEquals(storedArgumentTargetLink.space, sessionTargetLink.space);
    assertEquals(storedArgumentTargetLink.scope, sessionTargetLink.scope);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("isOpen").get() as unknown, true);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map updates when derived list is narrowed by session input", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { derive, handler, pattern } =
      createTrustedBuilder(runtime).commonfabric;

    const selectedRoomBase = runtime.getCell<string>(
      space,
      "map derived session selected room",
      undefined,
      tx,
    );
    const selectedRoom = createCell<string>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set("lobby");

    interface Message {
      body: string;
    }

    interface Conversation {
      rooms: Record<string, Message[]>;
    }

    const setConversation = handler<
      { conversation: Conversation },
      { conversation: Cell<Conversation> }
    >({
      type: "object",
      properties: {
        conversation: {
          type: "object",
          properties: {
            rooms: { type: "object" },
          },
          required: ["rooms"],
        },
      },
      required: ["conversation"],
    }, {
      type: "object",
      properties: {
        conversation: { asCell: true },
      },
      required: ["conversation"],
    }, ({ conversation: nextConversation }, { conversation }) => {
      conversation.set(nextConversation);
    });

    const Root = pattern<{
      conversation: Conversation;
      selectedRoom: string;
    }>(({ conversation, selectedRoom }) => {
      const messages = derive(
        { conversation, selectedRoom },
        (
          current: { conversation: Conversation; selectedRoom: string },
        ) => current.conversation.rooms[current.selectedRoom] ?? [],
      );
      const bodies = messages.map((message) =>
        derive(message, (current: Message) => current.body)
      );
      return {
        messages,
        bodies,
        setConversation: setConversation({
          conversation: conversation as unknown as Cell<Conversation>,
        }),
      };
    });

    const resultCell = runtime.getCell(
      space,
      "map updates derived session list",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      conversation: { rooms: { lobby: [] } },
      selectedRoom,
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawBodies = result.key("bodies").getRaw({
      lastNode: "writeRedirect",
    });
    const bodiesLink = parseLink(rawBodies, result);
    assertEquals(bodiesLink?.scope, "session");
    assertEquals(result.key("bodies").get() as unknown, []);

    result.key("setConversation").send({
      conversation: {
        rooms: {
          lobby: [{ body: "hello from scoped lobby" }],
        },
      },
    });
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(
      result.key("bodies").get() as unknown,
      ["hello from scoped lobby"],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map materializes initially populated list selected by session input", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { derive, pattern } = createTrustedBuilder(runtime).commonfabric;

    const selectedRoomBase = runtime.getCell<string>(
      space,
      "map initial session selected room",
      undefined,
      tx,
    );
    const selectedRoom = createCell<string>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set("lobby");

    interface Message {
      body: string;
    }

    interface Conversation {
      rooms: Record<string, Message[]>;
    }

    const Root = pattern<{
      conversation: Conversation;
      selectedRoom: string;
    }>(({ conversation, selectedRoom }) => {
      const messages = derive(
        { conversation, selectedRoom },
        (
          current: { conversation: Conversation; selectedRoom: string },
        ) => current.conversation.rooms[current.selectedRoom] ?? [],
      );
      const bodies = messages.map((message) =>
        derive(message, (current: Message) => current.body)
      );
      return { messages, bodies };
    });

    const resultCell = runtime.getCell(
      space,
      "map materializes initially populated session list",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      conversation: {
        rooms: {
          lobby: [{ body: "initial scoped lobby" }],
        },
      },
      selectedRoom,
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(
      result.key("bodies").get() as unknown,
      ["initial scoped lobby"],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("ifElse selected branch materializes map over session-derived list", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { derive, ifElse, pattern } =
      createTrustedBuilder(runtime).commonfabric;

    const selectedRoomBase = runtime.getCell<string>(
      space,
      "ifElse map session selected room",
      undefined,
      tx,
    );
    const selectedRoom = createCell<string>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set("lobby");

    interface Message {
      body: string;
    }

    interface Conversation {
      rooms: Record<string, Message[]>;
    }

    const Root = pattern<{
      conversation: Conversation;
      selectedRoom: string;
    }>(({ conversation, selectedRoom }) => {
      const messages = derive(
        { conversation, selectedRoom },
        (
          current: { conversation: Conversation; selectedRoom: string },
        ) => current.conversation.rooms[current.selectedRoom] ?? [],
      );
      const isEmpty = derive(
        messages,
        (current: Message[]) => current.length === 0,
      );
      const rendered = ifElse(
        isEmpty,
        [],
        messages.map((message) =>
          derive(message, (current: Message) => current.body)
        ),
      );
      return { rendered };
    });

    const resultCell = runtime.getCell(
      space,
      "ifElse selected map branch materializes",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      conversation: {
        rooms: {
          lobby: [{ body: "visible through selected map branch" }],
        },
      },
      selectedRoom,
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(
      result.key("rendered").get() as unknown,
      ["visible through selected map branch"],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("ifElse selected VNode branch materializes map over session-derived list", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { derive, h, ifElse, pattern } =
      createTrustedBuilder(runtime).commonfabric;

    const selectedRoomBase = runtime.getCell<string>(
      space,
      "ifElse vnode map session selected room",
      undefined,
      tx,
    );
    const selectedRoom = createCell<string>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set("lobby");

    interface Message {
      body: string;
    }

    interface Conversation {
      rooms: Record<string, Message[]>;
    }

    const Root = pattern<{
      conversation: Conversation;
      selectedRoom: string;
    }>(({ conversation, selectedRoom }) => {
      const messages = derive(
        { conversation, selectedRoom },
        (
          current: { conversation: Conversation; selectedRoom: string },
        ) => current.conversation.rooms[current.selectedRoom] ?? [],
      );
      const isEmpty = derive(
        messages,
        (current: Message[]) => current.length === 0,
      );
      const ui = ifElse(
        isEmpty,
        h("span", null, "empty"),
        h(
          "div",
          null,
          messages.map((message) =>
            h("span", null, derive(message, (current: Message) => current.body))
          ),
        ),
      );
      return { ui };
    });

    const resultCell = runtime.getCell(
      space,
      "ifElse selected vnode map branch materializes",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {
      conversation: {
        rooms: {
          lobby: [{ body: "visible in mapped vnode branch" }],
        },
      },
      selectedRoom,
    }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const uiLink = parseLink(
      result.key("ui").getRaw({ lastNode: "writeRedirect" }),
      result.key("ui"),
    );
    const rendered = uiLink && runtime.getCellFromLink(uiLink).getRaw() as any;
    const childRaw = Array.isArray(rendered?.children)
      ? rendered.children[0]
      : undefined;
    const nestedLink = childRaw && parseLink(childRaw, uiLink!);

    assertEquals(nestedLink?.scope, "space");
    assertEquals(
      JSON.stringify(runtime.getCellFromLink(nestedLink!).get()).includes(
        "visible in mapped vnode branch",
      ),
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map materializes list through session boxed space-scoped reference", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { derive, h, ifElse, pattern } =
      createTrustedBuilder(runtime).commonfabric;

    interface Message {
      body: string;
    }

    interface Room {
      name: string;
      messages: Message[];
    }

    interface SelectedRoom {
      room?: Room;
    }

    const container = runtime.getCell<{
      conversation: { rooms: Room[] };
    }>(
      space,
      "boxed selected room target container",
      undefined,
      tx,
    );
    const scopedContainer = createCell<{
      conversation: { rooms: Room[] };
    }>(
      runtime,
      { ...container.getAsNormalizedFullLink(), scope: "space" },
      tx,
    );
    scopedContainer.set({
      conversation: {
        rooms: [{
          name: "Library",
          messages: [{ body: "visible through boxed room ref" }],
        }],
      },
    });
    const room = scopedContainer.key("conversation", "rooms", 0) as Cell<Room>;

    const selectedRoomBase = runtime.getCell<SelectedRoom>(
      space,
      "boxed selected room session state",
      undefined,
      tx,
    );
    const selectedRoom = createCell<SelectedRoom>(
      runtime,
      { ...selectedRoomBase.getAsNormalizedFullLink(), scope: "session" },
      tx,
    );
    selectedRoom.set({});

    const Root = pattern<{ selectedRoom: SelectedRoom }>(
      ({ selectedRoom }) => {
        const selectedRoomRef = (selectedRoom as unknown as Cell<SelectedRoom>)
          .key("room") as Cell<Room>;
        const selectedRoomRefInputSchema = {
          type: "object",
          properties: {
            selectedRoomRef: {
              type: "object",
              properties: {
                name: { type: "string" },
                messages: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { body: { type: "string" } },
                    required: ["body"],
                  },
                },
              },
              required: ["name", "messages"],
              asCell: ["cell"],
            },
          },
          required: ["selectedRoomRef"],
        } as const;
        const messageCount = derive(
          selectedRoomRefInputSchema,
          { type: "number" } as const,
          { selectedRoomRef },
          (current: any) =>
            current.selectedRoomRef.get()?.messages?.length ?? 0,
        );
        const isEmpty = derive(
          messageCount,
          (current: number) => current === 0,
        );
        const ui = ifElse(
          isEmpty,
          h("span", null, "empty"),
          h(
            "div",
            null,
            derive(
              selectedRoomRefInputSchema,
              { type: "unknown" } as const,
              { selectedRoomRef },
              (current: any) =>
                current.selectedRoomRef.get()?.messages as Message[],
            ).map((message: any) =>
              h(
                "span",
                null,
                derive(message, (current: Message) => current.body),
              )
            ),
          ),
        );
        return { messageCount, ui };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "map through boxed scoped room reference",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { selectedRoom }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const updateTx = runtime.edit();
    selectedRoom.withTx(updateTx).set({ room: room as unknown as Room });
    await updateTx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    assertEquals(result.key("messageCount").get() as unknown, 1);
    assertEquals(
      JSON.stringify(result.key("ui").get()).includes(
        "visible through boxed room ref",
      ),
      true,
    );
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

    const rawFiltered = result.key("filtered").getRaw({
      lastNode: "writeRedirect",
    });
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

    const rawExpanded = result.key("expanded").getRaw({
      lastNode: "writeRedirect",
    });
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

    const rawValue = result.key("value").getRaw({
      lastNode: "writeRedirect",
    });
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
    // In this case, whenCell has a non-redirect link, so follow that
    const nextCell = runtime.getCellFromLink(parseLink(whenCell.getRaw())!);
    const selectedLink = parseLink(nextCell.getRaw());
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

    const rawText = result.key("text").getRaw({ lastNode: "writeRedirect" });
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

    const rawDialog = result.key("dialog").getRaw({
      lastNode: "writeRedirect",
    });
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

    const foundLink = parseLink(
      result.key("found").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
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

    const favoritesLink = parseLink(
      result.key("favorites").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
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

    const foundLink = parseLink(
      result.key("found").getRaw({ lastNode: "writeRedirect" }),
      result,
    );
    assertEquals(foundLink?.scope, "session");
    assertEquals(result.key("found").key("result").get() as unknown, {
      value: "scoped",
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
