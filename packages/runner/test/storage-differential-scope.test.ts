import { assertEquals } from "@std/assert";
import { hashOf } from "@commonfabric/data-model/value-hash";
import * as Differential from "../src/storage/differential.ts";
import type { IMemoryAddress, State } from "../src/storage/interface.ts";

Deno.test("differential checkout preserves scope for missing facts", () => {
  const fact = {
    the: "application/json",
    of: "of:scoped-differential-missing-fact",
    scope: "user",
    is: { value: "after" },
    cause: hashOf({ test: "scoped differential" }),
  } as State & { scope: "user" };
  const current = new Map<string, State>();
  const key = (address: IMemoryAddress) =>
    `${address.scope ?? "space"}:${address.type}:${address.id}`;
  const memory = {
    get: (address: IMemoryAddress) => current.get(key(address)),
  };

  const before = Differential.checkout(memory, [fact]);
  current.set(
    key({ id: fact.of, type: fact.the, scope: "user", path: [] }),
    fact,
  );

  const changes = [...before.compare(memory)];

  assertEquals(changes.length, 1);
  assertEquals(changes[0].address.scope, "user");
  assertEquals(changes[0].after, fact.is);
});
