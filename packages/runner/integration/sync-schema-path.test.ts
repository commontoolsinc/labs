#!/usr/bin/env -S deno run -A

import { assertEquals } from "@std/assert/equals";
import { type NormalizedLink, Runtime } from "@commontools/runner";
import { Identity, type IdentityCreateConfig } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "@commontools/runner";
import { parseLink } from "../src/link-utils.ts";

// Create test identity
const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};
const identity = await Identity.fromPassphrase("test operator", keyConfig);

console.log("\n=== TEST: Sync Schema uses Path ===");
const TOOLSHED_API_URL = Deno.env.get("TOOLSHED_API_URL") ??
  "http://localhost:8000/";

async function test() {
  // First runtime - save data
  const runtime1 = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", TOOLSHED_API_URL),
    }),
    blobbyServerUrl: "http://localhost:8000",
  });
  const addressSchema = {
    type: "object",
    properties: {
      "city": { type: "string" },
    },
    required: ["city"],
  } as const satisfies JSONSchema;
  const employeeSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: addressSchema,
    },
    required: ["name", "address"],
  } as const satisfies JSONSchema;
  const addressesArraySchema = {
    type: "array",
    items: addressSchema,
  } as const satisfies JSONSchema;
  const employeAddressesSchema = {
    type: "object",
    properties: {
      "addresses": addressesArraySchema,
    },
    required: ["addresses"],
  } as const satisfies JSONSchema;

  const space = identity.did();

  // Create an employee cell that has an address
  let tx = runtime1.edit();
  const testEmployeeCell = runtime1.getCell(
    space,
    `storage test employee cell`,
    employeeSchema,
    tx,
  );
  const employeeData = {
    name: "Bob",
    address: { city: "Los Angeles" },
  };
  testEmployeeCell.set(employeeData);
  await tx.commit();

  // Create a cell that points to the address portion of that cell
  tx = runtime1.edit();
  const testAddressesCell = runtime1.getCell(
    space,
    `storage test addresses cell`,
    employeAddressesSchema,
    tx,
  );
  testAddressesCell.set({ addresses: [testEmployeeCell.key("address")] });
  await tx.commit();

  await testAddressesCell.sync();
  await testEmployeeCell.sync();

  await runtime1.storage.synced();
  await runtime1.dispose();

  const addressesArrayCell1 = testAddressesCell.key("addresses");
  const addressesArrayCellLink1 = addressesArrayCell1.getAsNormalizedFullLink();

  // Attempt to load on runtime2
  const runtime2 = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", TOOLSHED_API_URL),
    }),
    blobbyServerUrl: "http://localhost:8000",
  });

  // When we build a cell from a cell link, we don't do the right thing with
  // rootSchema
  const addressesArrayCell2 = runtime2.getCellFromLink(
    addressesArrayCellLink1,
    addressesArraySchema,
    tx,
  );
  // This is a hack to set the root schema correctly -- really, the object
  // returned from getAsNormalizedFullLink should be a copy or readonly,
  // but since it's neither, we can fix things here.
  addressesArrayCell2.getAsNormalizedFullLink().rootSchema =
    employeAddressesSchema;
  const newCell = await addressesArrayCell2.sync();
  await runtime2.storage.synced();

  // At this point, we should have the employee's cell in our heap.
  // I don't want to use the sync system, since that will autoload,
  // so instead I'll extract the link myself, and check in the heap.
  // This will be the link to the employee's address field
  const sigilLink = JSON.parse(JSON.stringify(newCell.key(0).getRaw()));
  const normalizedLink = parseLink(sigilLink) as NormalizedLink;
  const record = runtime2.storageManager.open(normalizedLink.space!).get(
    normalizedLink.id!,
  );
  assertEquals(record?.value, employeeData);
  await runtime2.dispose();
}

await test();

console.log("\nDone");
Deno.exit(0);
