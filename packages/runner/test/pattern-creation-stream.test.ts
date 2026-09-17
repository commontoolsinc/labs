import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import { type Cell, Runtime, type RuntimeProgram } from "../src/index.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("new pattern stream ordering");

function program(
  crossSpace: boolean,
  navigate?: "return" | "void",
): RuntimeProgram {
  return {
    main: "/parent.tsx",
    files: [{
      name: "/parent.tsx",
      contents: `
        import { handler, navigateTo, pattern, Writable } from "commonfabric";
        import Child, { type ChildOutput } from "./child.tsx";
        const create = handler<{ value: string; fail?: boolean }, { children: Writable<ChildOutput[]> }>(
          (event, { children }) => {
            const child = Child${crossSpace ? ".inSpace()" : ""}({});
            const payload = { value: event.value };
            child.setValue.send(payload);
            payload.value = "changed after send";
            children.push(child);
            if (event.fail) throw new Error("creation refused");
            ${
        navigate === undefined
          ? ""
          : navigate === "return"
          ? "return navigateTo(child);"
          : "navigateTo(child);"
      }
          },
        );
        export default pattern(() => {
          const children = new Writable<ChildOutput[]>([]);
          return { children, create: create({ children }) };
        });
      `,
    }, {
      name: "/child.tsx",
      contents: `
        import { handler, pattern, type Stream, Writable } from "commonfabric";
        export interface ChildOutput { value: string; setValue: Stream<{ value: string }> }
        const setValue = handler<{ value: string }, { value: Writable<string> }>((event, { value }) => {
          value.set(event.value);
        });
        export default pattern<Record<string, never>, ChildOutput>(() => {
          const value = new Writable("").for("value");
          return { value, setValue: setValue({ value }) };
        });
      `,
    }],
  };
}

describe("pattern-creation-stream", () => {
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  beforeEach(() => {
    manager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://creation.test"),
      storageManager: manager,
    });
  });
  afterEach(async () => {
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.dispose();
    await manager.close();
  });

  async function createParent(
    crossSpace: boolean,
    navigate?: "return" | "void",
  ) {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(
      program(crossSpace, navigate),
      { space: signer.did(), tx },
    );
    const parent = runtime.getCell(signer.did(), "parent");
    runtime.runner.run(tx, pattern, {}, parent);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await parent.pull();
    return parent;
  }

  for (const crossSpace of [false, true]) {
    for (const fail of [false, true]) {
      it(`${fail ? "discards" : "delivers"} a new ${crossSpace ? "cross-space" : "same-space"} child's event when creation ${fail ? "fails" : "succeeds"}`, async () => {
        const parent = await createParent(crossSpace);
        const errors: unknown[] = [];
        runtime.scheduler.onError((error) => errors.push(error));
        using events = spy(runtime.scheduler, "queueEvent");
        const eventTx = runtime.edit();
        parent.withTx(eventTx).key("create").send({
          value: "sent value",
          fail,
        });
        runtime.prepareTxForCommit(eventTx);
        expect((await eventTx.commit()).error).toBeUndefined();
        await runtime.scheduler.idleWithPendingCommits();
        const children = parent.key("children").asSchema<Cell<unknown>[]>({
          type: "array",
          items: { type: "unknown", asCell: ["cell"] },
        });
        await children.pull();
        expect(events.calls).toHaveLength(fail ? 1 : 2);
        if (fail) {
          expect(errors).toHaveLength(1);
          expect(children.get()).toEqual([]);
        } else {
          expect(errors).toEqual([]);
          expect(children.get()).toHaveLength(1);
          const child = children.get()[0].withTx();
          await child.pull();
          expect(child.key("value").asSchema<string>({ type: "string" }).get())
            .toBe("sent value");
        }
      });
    }
  }

  for (const navigate of ["return", "void"] as const) {
    it(`refuses initialization events before a ${navigate}-valued navigation defers the child graph`, async () => {
      const parent = await createParent(true, navigate);
      const errors: unknown[] = [];
      runtime.scheduler.onError((error) => errors.push(error));
      using events = spy(runtime.scheduler, "queueEvent");
      const tx = runtime.edit();
      parent.withTx(tx).key("create").send({ value: "sent value" });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect((errors[0] as Error).message).toContain("startup is deferred");
      expect(events.calls).toHaveLength(1);
      const children = parent.key("children").asSchema<unknown[]>({
        type: "array",
      });
      await children.pull();
      expect(children.get()).toEqual([]);
      expect(runtime.runner.cancels.size).toBe(1);
    });
  }

  it("does not repeat a winning child's initialization event on redelivery", async () => {
    const parent = await createParent(true);
    using events = spy(runtime.scheduler, "queueEvent");
    const send = async (value: string) => {
      const tx = runtime.edit();
      parent.withTx(tx).key("create").send({ value }, undefined, {
        eventId: "create-once",
        session: "ses:creator",
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();
    };
    await send("winner");
    await send("duplicate");
    const children = parent.key("children").asSchema<Cell<unknown>[]>({
      type: "array",
      items: { type: "unknown", asCell: ["cell"] },
    });
    await children.pull();
    expect(children.get()).toHaveLength(1);
    const child = children.get()[0].withTx();
    await child.pull();
    expect(child.key("value").asSchema<string>({ type: "string" }).get()).toBe(
      "winner",
    );
    expect(events.calls).toHaveLength(3);
  });
});
