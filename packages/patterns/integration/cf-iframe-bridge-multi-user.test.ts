/**
 * Browser-level multiplayer coverage for cf-iframe's CellHandle bridge.
 *
 * Alice opens one piece in two independent browser sessions and Bob opens the
 * same piece under a different identity. Every mutation is commanded from the
 * shell page but performed inside its sandboxed iframe. Sibling readouts then
 * expose what each runtime sees, covering the real guest port, cf-iframe cell
 * adapter, scoped storage, runtime-client IPC, and SQLite bridge together.
 */

import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ANYONE_USER } from "@commonfabric/memory/acl";
import { ACLManager } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButton,
  fillCfInput,
  waitForRuntimeIdle,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

type BridgeCommand = {
  id: string;
  operation:
    | "write"
    | "sqlite-insert"
    | "sqlite-query"
    | "clear-database-rows";
  resource?: "shared" | "user" | "session";
  database?: "database" | "userDatabase" | "sessionDatabase";
  value?: string;
};

type BridgeValues = {
  shared: string;
  user: string;
  session: string;
  databaseRows: string;
  userDatabaseRows: string;
  sessionDatabaseRows: string;
  status: string;
};

type ContextHandleProbe = {
  context?: {
    ref: unknown;
    keys: string[];
    members: unknown;
    children?: unknown;
  };
  resolved?: { ref: unknown; keys: string[]; members: unknown };
  bridge?: unknown;
  error?: string;
};

async function readBridgeValues(page: Page): Promise<BridgeValues> {
  return await page.evaluate(() => {
    const find = (selector: string): Element | undefined => {
      const visit = (root: Document | ShadowRoot): Element | undefined => {
        for (const element of root.querySelectorAll("*")) {
          if (element.matches(selector)) return element;
          if (element.shadowRoot) {
            const match = visit(element.shadowRoot);
            if (match) return match;
          }
        }
        return undefined;
      };
      return visit(document);
    };
    const text = (selector: string) =>
      find(selector)?.textContent?.trim() ?? "";
    return {
      shared: text("#bridge-shared"),
      user: text("#bridge-user"),
      session: text("#bridge-session"),
      databaseRows: text("#bridge-database-rows"),
      userDatabaseRows: text("#bridge-user-database-rows"),
      sessionDatabaseRows: text("#bridge-session-database-rows"),
      status: text("#bridge-status"),
    };
  });
}

async function readContextHandleProbe(page: Page): Promise<ContextHandleProbe> {
  return await page.evaluate(async () => {
    const visit = (root: Document | ShadowRoot): Element | undefined => {
      for (const element of root.querySelectorAll("*")) {
        if (element.matches("cf-iframe")) return element;
        if (element.shadowRoot) {
          const match = visit(element.shadowRoot);
          if (match) return match;
        }
      }
      return undefined;
    };
    const element = visit(document) as
      | (Element & {
        _contextBridge?: {
          resources: Record<
            string,
            {
              kind: string;
              schema?: unknown;
              methods?: Record<string, unknown>;
            }
          >;
        };
        context?: {
          ref(): unknown;
          get(): unknown;
          sync(): Promise<unknown>;
          key(name: string): {
            ref(): unknown;
            resolveAsCell(): Promise<{ ref(): unknown }>;
          };
          resolveAsCell(): Promise<{
            ref(): unknown;
            get(): unknown;
            sync(): Promise<unknown>;
          }>;
        };
      })
      | undefined;
    const context = element?.context;
    if (!context) return { error: "cf-iframe has no context handle" };
    const summarize = (handle: { ref(): unknown; get(): unknown }) => {
      const value = handle.get();
      const members = value && typeof value === "object"
        ? Object.fromEntries(
          Object.entries(value).map(([key, member]) => [
            key,
            member && typeof member === "object" && "ref" in member &&
              typeof member.ref === "function"
              ? { kind: "cell", ref: member.ref() }
              : member && typeof member === "object"
              ? {
                kind: "object",
                constructor: member.constructor?.name,
                keys: Object.keys(member),
                value: member,
              }
              : { kind: typeof member },
          ]),
        )
        : {};
      return {
        ref: handle.ref(),
        keys: value && typeof value === "object" ? Object.keys(value) : [],
        members,
      };
    };
    try {
      await context.sync();
      const resolved = await context.resolveAsCell();
      await resolved.sync();
      const contextSummary = summarize(context);
      const children = await Promise.all(
        contextSummary.keys.map(async (name) => {
          const child = context.key(name);
          const childResolved = await child.resolveAsCell();
          return {
            name,
            ref: child.ref(),
            resolvedRef: childResolved.ref(),
          };
        }),
      );
      return {
        context: { ...contextSummary, children },
        resolved: summarize(resolved),
        bridge: Object.fromEntries(
          Object.entries(element?._contextBridge?.resources ?? {}).map(
            ([name, resource]) => [name, {
              kind: resource.kind,
              schema: resource.schema,
              methods: Object.keys(resource.methods ?? {}),
            }],
          ),
        ),
      };
    } catch (error) {
      return {
        context: summarize(context),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function issueCommand(page: Page, command: BridgeCommand): Promise<void> {
  await fillCfInput(page, "#bridge-command", JSON.stringify(command));
  await waitForBridgeStatus(page, `done:${command.id}`);
  expect((await readBridgeValues(page)).status).toBe(`done:${command.id}`);
}

async function waitForBridgeStatus(
  page: Page,
  expected: string,
): Promise<void> {
  const result = await waitForCondition(
    page,
    (probe, expectedStatus) => {
      const status = probe.collect("#bridge-status")[0];
      const statusText = status ? probe.deepText(status).trim() : "";
      if (statusText === expectedStatus) {
        return { status: statusText, error: "" };
      }
      const error = probe.collect(".error-modal .error-content")[0];
      if (error) {
        return { status: statusText, error: probe.deepText(error).trim() };
      }
      return false;
    },
    { args: [expected] },
  );
  if (result?.error) {
    const context = await readContextHandleProbe(page);
    throw new Error(
      `cf-iframe reported an error while waiting for status ` +
        `${JSON.stringify(expected)}: ${result.error}\nContext probe: ` +
        JSON.stringify(context, null, 2),
    );
  }
}

async function waitForBridgeRowsContaining(
  page: Page,
  expected: readonly string[],
  selector = "#bridge-database-rows",
): Promise<void> {
  const result = await waitForCondition(
    page,
    (probe, options) => {
      const { expectedRows, rowSelector } = options;
      const rows = probe.collect(rowSelector)[0];
      const values = rows
        ? probe.deepText(rows).trim().split(",").filter(Boolean)
        : [];
      if (expectedRows.every((value) => values.includes(value))) {
        return { rows: values, error: "" };
      }
      const error = probe.collect(".error-modal .error-content")[0];
      if (error) {
        return { rows: values, error: probe.deepText(error).trim() };
      }
      return false;
    },
    { args: [{ expectedRows: expected, rowSelector: selector }] },
  );
  if (result?.error) {
    throw new Error(
      `cf-iframe reported an error while waiting for SQLite rows ` +
        `${JSON.stringify(expected)}: ${result.error}`,
    );
  }
}

describe("cf-iframe bridge with multiple users", () => {
  const aliceOneShell = new ShellIntegration({
    presentation: { id: "alice-one", label: "Alice · session 1" },
  });
  const aliceTwoShell = new ShellIntegration({
    presentation: { id: "alice-two", label: "Alice · session 2" },
  });
  const bobShell = new ShellIntegration({
    presentation: { id: "bob", label: "Bob" },
  });
  const shells = [aliceOneShell, aliceTwoShell, bobShell];
  shells.forEach((shell) => shell.bindLifecycle());

  let aliceIdentity: Identity;
  let bobIdentity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let resultSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    [aliceIdentity, bobIdentity] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: aliceIdentity,
    });
    await new ACLManager(cc.runtime, cc.getSpace()).set(ANYONE_USER, "WRITE");
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "fixtures",
      "cf-iframe-bridge-multi-user",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    resultSinkCancel = cc.getResult(piece.getCell()).sink(() => {});
  });

  afterAll(async () => {
    resultSinkCancel?.();
    await cc?.dispose();
  });

  it("preserves `PerSpace`, `PerUser`, `PerSession`, and SQLite data at their declared boundaries", async () => {
    const view = {
      spaceDid: cc.getSpace() as `did:${string}:${string}`,
      pieceId,
    };
    const identities = [aliceIdentity, aliceIdentity, bobIdentity];
    const pages = shells.map((shell) => shell.page());

    await Promise.all(shells.map((shell, index) =>
      shell.goto({
        frontendUrl: FRONTEND_URL,
        view,
        identity: identities[index],
      })
    ));
    await Promise.all(pages.map((page) => waitForRuntimeIdle(page)));
    await Promise.all(
      pages.map((page) => waitForBridgeStatus(page, "ready")),
    );

    expect((await aliceOneShell.state())?.identityDid).toBe(
      aliceIdentity.did(),
    );
    expect((await aliceTwoShell.state())?.identityDid).toBe(
      aliceIdentity.did(),
    );
    expect((await bobShell.state())?.identityDid).toBe(bobIdentity.did());
    for (const page of pages) {
      expect(await readBridgeValues(page)).toMatchObject({
        shared: "",
        user: "",
        session: "",
        status: "ready",
      });
    }

    await issueCommand(pages[0], {
      id: "shared-one",
      operation: "write",
      resource: "shared",
      value: "space-one",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(page, "#bridge-shared", "space-one")
      ),
    );

    await issueCommand(pages[0], {
      id: "alice-user",
      operation: "write",
      resource: "user",
      value: "alice-user",
    });
    await waitForSettledText(pages[1], "#bridge-user", "alice-user");
    await issueCommand(pages[0], {
      id: "user-barrier",
      operation: "write",
      resource: "shared",
      value: "space-after-alice-user",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(
          page,
          "#bridge-shared",
          "space-after-alice-user",
        )
      ),
    );
    expect((await readBridgeValues(pages[2])).user).toBe("");

    await issueCommand(pages[2], {
      id: "bob-user",
      operation: "write",
      resource: "user",
      value: "bob-user",
    });
    await issueCommand(pages[2], {
      id: "bob-user-barrier",
      operation: "write",
      resource: "shared",
      value: "space-after-bob-user",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(page, "#bridge-shared", "space-after-bob-user")
      ),
    );
    expect((await readBridgeValues(pages[0])).user).toBe("alice-user");
    expect((await readBridgeValues(pages[1])).user).toBe("alice-user");
    expect((await readBridgeValues(pages[2])).user).toBe("bob-user");

    await issueCommand(pages[0], {
      id: "alice-session-one",
      operation: "write",
      resource: "session",
      value: "alice-session-one",
    });
    await issueCommand(pages[0], {
      id: "session-one-barrier",
      operation: "write",
      resource: "shared",
      value: "space-after-session-one",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(page, "#bridge-shared", "space-after-session-one")
      ),
    );
    expect((await readBridgeValues(pages[1])).session).toBe("");
    expect((await readBridgeValues(pages[2])).session).toBe("");

    await issueCommand(pages[1], {
      id: "alice-session-two",
      operation: "write",
      resource: "session",
      value: "alice-session-two",
    });
    await issueCommand(pages[1], {
      id: "session-two-barrier",
      operation: "write",
      resource: "shared",
      value: "space-after-session-two",
    });
    await Promise.all(
      pages.map((page) =>
        waitForSettledText(page, "#bridge-shared", "space-after-session-two")
      ),
    );
    expect((await readBridgeValues(pages[0])).session).toBe(
      "alice-session-one",
    );
    expect((await readBridgeValues(pages[1])).session).toBe(
      "alice-session-two",
    );
    expect((await readBridgeValues(pages[2])).session).toBe("");

    const aliceRow = `alice-${pieceId}`;
    const bobRow = `bob-${pieceId}`;
    await issueCommand(pages[0], {
      id: "sqlite-alice",
      operation: "sqlite-insert",
      value: aliceRow,
    });
    await Promise.all(
      pages.map((page) => waitForBridgeRowsContaining(page, [aliceRow])),
    );
    await issueCommand(pages[2], {
      id: "sqlite-bob",
      operation: "sqlite-insert",
      value: bobRow,
    });
    await Promise.all(
      pages.map((page) =>
        waitForBridgeRowsContaining(page, [aliceRow, bobRow])
      ),
    );
    const durableDatabaseRows = (await readBridgeValues(pages[0])).databaseRows;
    await Promise.all(
      pages.slice(1).map((page) =>
        waitForSettledText(
          page,
          "#bridge-database-rows",
          durableDatabaseRows,
        )
      ),
    );

    const aliceUserDatabaseRow = `alice-user-db-${pieceId}`;
    const bobUserDatabaseRow = `bob-user-db-${pieceId}`;
    await issueCommand(pages[0], {
      id: "sqlite-user-alice",
      operation: "sqlite-insert",
      database: "userDatabase",
      value: aliceUserDatabaseRow,
    });
    await Promise.all(
      pages.slice(0, 2).map((page) =>
        waitForBridgeRowsContaining(
          page,
          [aliceUserDatabaseRow],
          "#bridge-user-database-rows",
        )
      ),
    );
    expect((await readBridgeValues(pages[2])).userDatabaseRows).toBe("");

    await issueCommand(pages[2], {
      id: "sqlite-user-bob",
      operation: "sqlite-insert",
      database: "userDatabase",
      value: bobUserDatabaseRow,
    });
    await waitForBridgeRowsContaining(
      pages[2],
      [bobUserDatabaseRow],
      "#bridge-user-database-rows",
    );
    expect((await readBridgeValues(pages[0])).userDatabaseRows).toBe(
      aliceUserDatabaseRow,
    );
    expect((await readBridgeValues(pages[1])).userDatabaseRows).toBe(
      aliceUserDatabaseRow,
    );

    const aliceSessionOneDatabaseRow = `alice-session-1-db-${pieceId}`;
    const aliceSessionTwoDatabaseRow = `alice-session-2-db-${pieceId}`;
    await issueCommand(pages[0], {
      id: "sqlite-session-one",
      operation: "sqlite-insert",
      database: "sessionDatabase",
      value: aliceSessionOneDatabaseRow,
    });
    await waitForBridgeRowsContaining(
      pages[0],
      [aliceSessionOneDatabaseRow],
      "#bridge-session-database-rows",
    );
    expect((await readBridgeValues(pages[1])).sessionDatabaseRows).toBe("");
    expect((await readBridgeValues(pages[2])).sessionDatabaseRows).toBe("");

    await issueCommand(pages[1], {
      id: "sqlite-session-two",
      operation: "sqlite-insert",
      database: "sessionDatabase",
      value: aliceSessionTwoDatabaseRow,
    });
    await waitForBridgeRowsContaining(
      pages[1],
      [aliceSessionTwoDatabaseRow],
      "#bridge-session-database-rows",
    );
    expect((await readBridgeValues(pages[0])).sessionDatabaseRows).toBe(
      aliceSessionOneDatabaseRow,
    );

    await issueCommand(pages[0], {
      id: "clear-database-readouts",
      operation: "clear-database-rows",
    });
    expect(await readBridgeValues(pages[0])).toMatchObject({
      databaseRows: "",
      userDatabaseRows: "",
      sessionDatabaseRows: "",
    });

    await clickCfButton(pages[0], "#bridge-reload");
    await waitForBridgeStatus(pages[0], "ready");
    await Promise.all([
      waitForBridgeRowsContaining(pages[0], [aliceRow, bobRow]),
      waitForBridgeRowsContaining(
        pages[0],
        [aliceUserDatabaseRow],
        "#bridge-user-database-rows",
      ),
      waitForBridgeRowsContaining(
        pages[0],
        [aliceSessionOneDatabaseRow],
        "#bridge-session-database-rows",
      ),
    ]);
    expect(await readBridgeValues(pages[0])).toEqual({
      shared: "space-after-session-two",
      user: "alice-user",
      session: "alice-session-one",
      databaseRows: durableDatabaseRows,
      userDatabaseRows: aliceUserDatabaseRow,
      sessionDatabaseRows: aliceSessionOneDatabaseRow,
      status: "ready",
    });
    expect(await readBridgeValues(pages[1])).toEqual({
      shared: "space-after-session-two",
      user: "alice-user",
      session: "alice-session-two",
      databaseRows: durableDatabaseRows,
      userDatabaseRows: aliceUserDatabaseRow,
      sessionDatabaseRows: aliceSessionTwoDatabaseRow,
      status: "done:sqlite-session-two",
    });
    expect(await readBridgeValues(pages[2])).toEqual({
      shared: "space-after-session-two",
      user: "bob-user",
      session: "",
      databaseRows: durableDatabaseRows,
      userDatabaseRows: bobUserDatabaseRow,
      sessionDatabaseRows: "",
      status: "done:sqlite-user-bob",
    });
  });
});
