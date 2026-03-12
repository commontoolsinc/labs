import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import * as Memory from "../memory.ts";
import * as Provider from "../provider.ts";

const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";

Deno.test("legacy memory entry points default to v1 internally", async () => {
  const emulated = Memory.emulate({ serviceDid });
  assertEquals(emulated.memoryVersion, "v1");
  await emulated.close();

  const opened = await Memory.open({
    store: new URL("memory://"),
    serviceDid,
  });
  if (!opened.ok) {
    throw new Error(`Expected memory.open to succeed, got ${opened.error.message}`);
  }
  assertEquals(opened.ok.memoryVersion, "v1");
  await opened.ok.close();
});

Deno.test("legacy memory entry points reject explicit v2", async () => {
  const opened = await Memory.open({
    store: new URL("memory://"),
    serviceDid,
    memoryVersion: "v2",
  });
  if (!opened.error) {
    throw new Error("Expected memory.open to reject memoryVersion=v2");
  }
  assertEquals(opened.error.name, "ConnectionError");
  assertStringIncludes(opened.error.message, "memory/v1 entry point");

  assertThrows(
    () => Memory.emulate({ serviceDid, memoryVersion: "v2" }),
    Error,
    "memory/v1 entry point",
  );
});

Deno.test("legacy provider entry points reject explicit v2", async () => {
  const opened = await Provider.open({
    store: new URL("memory://"),
    serviceDid,
    memoryVersion: "v2",
  });
  if (!opened.error) {
    throw new Error("Expected provider.open to reject memoryVersion=v2");
  }
  assertEquals(opened.error.name, "ConnectionError");
  assertStringIncludes(opened.error.message, "memory/v1 entry point");

  assertThrows(
    () => Provider.emulate({ serviceDid, memoryVersion: "v2" }),
    Error,
    "memory/v1 entry point",
  );
});
