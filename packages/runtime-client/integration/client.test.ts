#!/usr/bin/env -S deno run -A

import {
  createSession,
  Identity,
  IdentityCreateConfig,
  Session,
} from "@commontools/identity";
import { env, waitFor } from "@commontools/integration";
import {
  CellHandle,
  type JSONSchema,
  RuntimeClient,
  type VNode,
} from "@commontools/runtime-client";
import { vdomSchema } from "@commontools/runner/schemas";
import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Program } from "@commontools/js-compiler";
import { render } from "@commontools/html/client";
import { MockDoc } from "@commontools/html/mock-doc";
import { WebWorkerRuntimeTransport } from "@commontools/runtime-client/transports/web-worker";

const { API_URL } = env;

// Use a deserializable key implementation in Deno,
// as we cannot currently transfer WebCrypto implementation keys
// across serialized boundary
const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};

const identity = await Identity.fromPassphrase("test operator", keyConfig);
const spaceName = globalThis.crypto.randomUUID();

const TEST_PROGRAM = `/// <cts-enable />
import { Cell, NAME, pattern, UI } from "commontools";
export default pattern((_) => {
  const cell = Cell.of("hello");
  return {
    [NAME]: "Home",
    [UI]: (
      <h1>
        home<strong>{cell}</strong>
      </h1>
    ),
  };
});`;

const TEMP_PATTERN = `/// <cts-enable />
import { Default, NAME, recipe, UI } from "commontools";

interface RecipeState {
  count: Default<number, 0>;
  label: Default<string, "">;
}

export default recipe<RecipeState>("ConditionalRecipe", (state) => {
  return {
    [NAME]: state.label,
    [UI]: (
      <section>
        {state && state.count > 0 ? <p>Positive</p> : <p>Non-positive</p>}
      </section>
    ),
  };
});
`;

describe("RuntimeClient", () => {
  describe("lifecycle", () => {
    it("initializes and reaches ready state", async () => {
      const session = await createSession({ identity, spaceName });
      const rt = await createRuntimeClient(session);
      await rt.dispose();
    });
  });

  describe("cell operations", () => {
    it("creates a cell with getCell and syncs its value", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

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

      const input = { message: "hi", count: 0 };
      await cell.set(input);
      await cell.sync();
      const value = await new Promise((resolve) => {
        cell.subscribe((value) => {
          resolve(value);
        });
      });
      assertEquals(value, input);
    });

    it("recursively returns VNodes inline with schema-driven serialization", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const page = await rt.createPage(TEMP_PATTERN, {
        run: true,
      });
      const cell = page.cell();
      const value = await cell.sync() as { $UI?: VNode; $NAME?: string };
      // With schema-driven serialization (asCell: true), children are resolved
      // inline as VNodes rather than wrapped in CellHandle indirection.
      const children = value.$UI?.children as VNode[];
      const firstChild = children?.[0];
      assertEquals(firstChild?.children, ["Non-positive"]);
      assertEquals(firstChild?.name, "p");
    });

    it("resolves cell links with resolveAsCell()", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      // Create a target cell with some data
      const targetSchema = {
        type: "object",
        properties: { value: { type: "string" } },
      } as const satisfies JSONSchema;

      const targetCell = await rt.getCell<{ value: string }>(
        session.space,
        "resolve-target-" + Date.now(),
        targetSchema,
      );
      await targetCell.set({ value: "resolved!" });
      await rt.idle();

      // Create a source cell that contains a link to the target
      const sourceSchema = {
        type: "object",
        properties: { link: { type: "object" } },
      } as const satisfies JSONSchema;

      const sourceCell = await rt.getCell<{ link: unknown }>(
        session.space,
        "resolve-source-" + Date.now(),
        sourceSchema,
      );
      await sourceCell.set({ link: targetCell });
      await rt.idle();
      await sourceCell.sync();

      // Get the link cell and resolve it
      const linkCell = sourceCell.key("link");
      const resolved = await linkCell.resolveAsCell();

      // The resolved cell should point to the target
      assertEquals(resolved.id(), targetCell.id());
    });

    it("subscribes to cell updates via subscribe()", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

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
      const cancel = cell.subscribe((value) => {
        if (!value) throw new Error("cell was not synced");
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

  describe("page operations", () => {
    it("creates a page from URL and retrieves it", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const page = await rt.createPage(TEST_PROGRAM, {
        run: true,
      });
      assertExists(page.id());
    });

    it("starts and stops page execution", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const page = await rt.createPage(TEST_PROGRAM, {
        run: false,
      });
      await page.start();
      await rt.idle();
      await page.stop();
    });

    it("removes a page", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const page = await rt.createPage(TEST_PROGRAM, {
        run: false,
      });
      await rt.removePage(page.id());
      await rt.synced();

      // Note: getPage may still return a reference to a removed page
      // because the ID still maps to a cell that existed. The removal
      // affects the pages list, not the ability to lookup by ID.
    });

    it("gets the pages list cell", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const charmsListCell = await rt.getCharmsListCell();
      assertExists(charmsListCell);

      await charmsListCell.sync();
      const link = charmsListCell.ref();
      assertExists(link);
    });
  });

  describe("events", () => {
    it("emits console events from page execution", async () => {
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
      await using rt = await createRuntimeClient(session);

      const consoleEvents: { method: string; args: unknown[] }[] = [];
      rt.on(
        "console",
        (
          event,
        ) => {
          consoleEvents.push(event);
        },
      );

      await rt.createPage(consoleProgram, { run: true });
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

  describe("event handlers", () => {
    it("sends events to stream cells without schema error", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      // Create a cell with undefined schema (simulating what happens with handler streams)
      const cell = await rt.getCell(
        session.space,
        "test-stream-send-" + Date.now(),
        undefined, // No schema - this is what causes the proxy fallback
      );

      cell.send({ type: "click", target: "button" });

      await rt.idle();
      await cell.sync();

      // Verify the event was stored
      const value = cell.get() as { type?: string };
      assertEquals(value?.type, "click", "Event should be stored in cell");
    });

    it("sends events to nested stream cell paths without schema error", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      // Create a root cell that will have the structure like a process cell
      const rootCell = await rt.getCell(
        session.space,
        "test-nested-stream-" + Date.now(),
        undefined,
      );

      // First, set up the internal structure
      rootCell.set({ internal: {} });
      await rt.idle();
      await rootCell.sync();

      // Now get a nested cell reference to internal/__#0stream (mimicking handler stream path)
      const internalCell = (rootCell as any).key("internal");
      const streamCell = (internalCell as any).key("__#0stream");
      streamCell.send({ type: "click" });

      await rt.idle();
      await rootCell.sync();
    });
  });

  describe("html render", () => {
    it("retrieves UI markup from page cell", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const page = await rt.createPage(TEST_PROGRAM, {
        run: true,
      });
      const cell = page.cell();
      await cell.sync();
      const value = cell.get() as { $UI?: VNode; $NAME?: string };

      // Verify we can access the UI markup
      assertExists(value.$UI, "Cell should have $UI property");
      assertEquals(value.$UI.type, "vnode");
      assertEquals(value.$UI.name, "h1");
    });

    it("renders page UI using html render function with CellHandle", async () => {
      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const page = await rt.createPage(TEST_PROGRAM, {
        run: true,
      });
      const cell = page.cell();
      await cell.sync();
      const typedCell = cell as typeof cell & { key(k: "$UI"): typeof cell };
      const uiCell = typedCell.key("$UI").asSchema(vdomSchema);
      await uiCell.sync();

      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, uiCell as any, renderOptions);

      const expected = "<h1>home<strong>hello</strong></h1>";
      await waitFor(() => Promise.resolve(root.innerHTML === expected));
      assertEquals(
        root.innerHTML,
        expected,
        "Should render the page UI correctly",
      );

      cancel();
    });

    it("renders cell values in VNode children", async () => {
      // Pattern that renders a state value in the UI
      const valuePattern = `/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";

interface State {
  value: Default<number, 10>;
}

export default pattern<State>(({ value }) => {
  return {
    [NAME]: "Value Test",
    [UI]: (
      <div>
        <span id="value">Value is {value}</span>
      </div>
    ),
  };
});`;

      const valueProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: valuePattern,
        }],
      };

      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const page = await rt.createPage(valueProgram, {
        run: true,
      });
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, page.cell() as any, renderOptions);

      await waitFor(
        () => Promise.resolve(root.innerHTML.includes("Value is 10")),
        { timeout: 5000 },
      );

      cancel();
    });

    it("renders derived cell values (like nth function)", async () => {
      // Pattern that uses a derived expression similar to counter's nth(state.value)
      const derivedPattern = `/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";

function formatValue(n: number): string {
  return "number-" + n;
}

interface State {
  value: Default<number, 42>;
}

export default pattern<State>(({ value }) => {
  return {
    [NAME]: "Derived Test",
    [UI]: (
      <div>
        <span id="result">Result: {formatValue(value)}</span>
      </div>
    ),
  };
});`;

      const derivedProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: derivedPattern,
        }],
      };

      const session = await createSession({ identity, spaceName });
      await using rt = await createRuntimeClient(session);

      const page = await rt.createPage(derivedProgram, {
        run: true,
      });
      const cell = page.cell() as CellHandle<VNode>;
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, cell, renderOptions);

      await waitFor(
        () => Promise.resolve(root.innerHTML.includes("Result: number-42")),
        { timeout: 15000 },
      );
      cancel();
    });
  });
});

async function createRuntimeClient(session: Session): Promise<RuntimeClient> {
  // If a space identity was created, replace it with a transferrable
  // key in Deno using the same derivation as Session
  if (session.spaceIdentity && session.spaceName) {
    session.spaceIdentity = await (
      await Identity.fromPassphrase("common user", keyConfig)
    ).derive(session.spaceName, keyConfig);
  }

  const transport = await WebWorkerRuntimeTransport.connect();
  const worker = await RuntimeClient.initialize(transport, {
    apiUrl: new URL(API_URL),
    identity: session.as,
    spaceIdentity: session.spaceIdentity,
    spaceDid: session.space,
    spaceName: session.spaceName,
  });

  await worker.synced();
  return worker;
}
