#!/usr/bin/env -S deno run -A

import {
  createSession,
  Identity,
  IdentityCreateConfig,
  Session,
} from "@commontools/identity";
import { type JSONSchema } from "@commontools/runner";
import { env, waitFor } from "@commontools/integration";
import { RuntimeWorker, RuntimeWorkerState } from "@commontools/runner/worker";
import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Program } from "@commontools/js-compiler";
import { render, vdomSchema, type VNode } from "@commontools/html";
import { MockDoc } from "@commontools/html/mock-doc";

const { API_URL } = env;

// Use a deserializable key implementation in Deno,
// as we cannot currently transfer WebCrypto implementation keys
// across serialized boundary
const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};

const identity = await Identity.fromPassphrase("test operator", keyConfig);
const spaceName = globalThis.crypto.randomUUID();

const TEST_PATTERN = `/// <cts-enable />
import { NAME, pattern, UI } from "commontools";
export default pattern((_) => {
  return {
    [NAME]: "Home",
    [UI]: (
      <h1>
        home<strong>space</strong>
      </h1>
    ),
  };
});`;

const TEST_PROGRAM: Program = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: TEST_PATTERN,
  }],
};

describe("RuntimeWorker", () => {
  describe("lifecycle", () => {
    it("initializes and reaches ready state", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      assertEquals(rt.isReady(), true);
      assertEquals(rt.state, RuntimeWorkerState.Ready);
      await rt.dispose();
      assertEquals(rt.state, RuntimeWorkerState.Terminated);
    });
  });

  describe("cell operations", () => {
    it("creates a cell with getCell and syncs its value", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const schema = {
        type: "object",
        properties: {
          message: { type: "string" },
          count: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const cause = "test-cell-" + Date.now();
      const cell = await rt.getCell<{ message: string; count: number }>(
        session.space,
        cause,
        schema,
      );

      await cell.sync();
      await rt.synced();

      // Cell should exist and have a link
      const link = cell.getAsLink();
      assertExists(link);
      assertExists(link["/"]["link@1"].id);
    });

    it("receives values via sink subscription after set", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const cell = await rt.getCell<{ value: number }>(
        session.space,
        "test-sink-set-" + Date.now(),
        schema,
      );

      let lastValue: { value: number } | undefined;
      const cancel = cell.sink((value) => {
        lastValue = value;
      });

      cell.set({ value: 42 });

      await waitFor(() => Promise.resolve(lastValue?.value === 42), {
        timeout: 5000,
      });

      cancel();
      assertEquals(lastValue, { value: 42 });
    });

    it("subscribes to cell updates via sink()", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const schema = {
        type: "object",
        properties: { counter: { type: "number" } },
      } as const satisfies JSONSchema;

      const cell = await rt.getCell<{ counter: number }>(
        session.space,
        "test-sink-" + Date.now(),
        schema,
      );

      cell.set({ counter: 0 });
      await rt.idle();
      await cell.sync();

      const receivedValues: { counter: number }[] = [];
      const cancel = cell.sink((value) => {
        receivedValues.push(value);
      });

      cell.set({ counter: 1 });
      cell.set({ counter: 2 });
      cell.set({ counter: 3 });

      await waitFor(() => Promise.resolve(receivedValues.length >= 3), {
        timeout: 5000,
      });

      cancel();

      // Should have received updates (may include initial value)
      assertEquals(receivedValues.length >= 3, true);
      assertEquals(receivedValues[receivedValues.length - 1], { counter: 3 });
    });
  });

  describe("charm operations", () => {
    it("creates a charm from URL and retrieves it", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const { id, cell } = await rt.createCharmFromProgram(TEST_PROGRAM, {
        run: true,
      });

      assertExists(id);
      assertExists(cell);

      const retrieved = await rt.getCharm(id);
      assertExists(retrieved);
      assertEquals(retrieved.id, id);
    });

    it("starts and stops charm execution", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      // Create without running
      const { id } = await rt.createCharmFromProgram(TEST_PROGRAM, {
        run: false,
      });

      await rt.startCharm(id);
      await rt.idle();
      await rt.stopCharm(id);
      await rt.idle();
      const charm = await rt.getCharm(id);
      assertExists(charm);
    });

    it("removes a charm", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const { id } = await rt.createCharmFromProgram(TEST_PROGRAM, {
        run: false,
      });

      // Verify it exists
      const charm = await rt.getCharm(id);
      assertExists(charm);

      // Remove it - this should complete without error
      await rt.removeCharm(id);
      await rt.synced();

      // Note: getCharm may still return a reference to a removed charm
      // because the ID still maps to a cell that existed. The removal
      // affects the charms list, not the ability to lookup by ID.
    });

    it("gets the charms list cell", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const charmsListCell = await rt.getCharmsListCell();
      assertExists(charmsListCell);

      await charmsListCell.sync();
      const link = charmsListCell.getAsLink();
      assertExists(link);
    });
  });

  describe("events", () => {
    it("emits console events from charm execution", async () => {
      const consolePattern = `/// <cts-enable />
import { NAME, pattern, UI } from "commontools";
export default pattern((_) => {
  console.log('hello');
  return {
    [NAME]: "Home",
    [UI]: (<span>console</span>),
  };
});`;

      const consoleProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: consolePattern,
        }],
      };
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const consoleEvents: { method: string; args: unknown[] }[] = [];
      rt.addEventListener(
        "console",
        ((
          event: CustomEvent<{ method: string; args: unknown[] }>,
        ) => {
          consoleEvents.push(event.detail);
        }) as EventListener,
      );

      await rt.createCharmFromProgram(consoleProgram, { run: true });
      await rt.idle();

      await waitFor(
        () =>
          Promise.resolve(
            consoleEvents.length > 0 && consoleEvents[0].args[0] === "hello",
          ),
        {
          timeout: 5000,
        },
      );
    });
  });

  describe("html render", () => {
    it("retrieves UI markup from charm cell", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const { cell } = await rt.createCharmFromProgram(TEST_PROGRAM, {
        run: true,
      });

      // Wait for charm to fully execute
      await rt.idle();

      // Sync the cell to get its value
      await cell.sync();
      const value = cell.get() as { $UI?: VNode; $NAME?: string };

      // Verify we can access the UI markup
      assertExists(value.$UI, "Cell should have $UI property");
      assertEquals(value.$UI.type, "vnode");
      assertEquals(value.$UI.name, "h1");
    });

    it("renders charm UI using html render function with RemoteCell", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeWorker(session);

      const { cell } = await rt.createCharmFromProgram(TEST_PROGRAM, {
        run: true,
      });
      await rt.idle();

      // Sync the cell and get the UI sub-cell
      await cell.sync();
      const typedCell = cell as typeof cell & { key(k: "$UI"): typeof cell };
      const uiCell = typedCell.key("$UI").asSchema(vdomSchema);
      await uiCell.sync();

      // Set up mock document for rendering
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      // Render using the RemoteCell
      const cancel = render(root, uiCell as any, renderOptions);

      // Verify the rendered output
      assertEquals(
        root.innerHTML,
        "<h1>home<strong>space</strong></h1>",
        "Should render the charm UI correctly",
      );

      cancel();
    });
  });
});

async function createRuntimeWorker(session: Session): Promise<RuntimeWorker> {
  const workerUrl = new URL("../src/worker/worker-runtime.ts", import.meta.url);

  // If a space identity was created, replace it with a transferrable
  // key in Deno using the same derivation as Session
  if (session.spaceIdentity && session.spaceName) {
    session.spaceIdentity = await (
      await Identity.fromPassphrase("common user", keyConfig)
    ).derive(session.spaceName, keyConfig);
  }

  const worker = new RuntimeWorker({
    apiUrl: new URL(API_URL),
    identity: session.as,
    spaceIdentity: session.spaceIdentity,
    spaceDid: session.space,
    spaceName: session.spaceName,
    workerUrl,
  });

  // Wait for CharmManager to sync
  await worker.synced();
  return worker;
}
