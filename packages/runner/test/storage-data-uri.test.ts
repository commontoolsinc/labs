import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createFactoryShell,
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";

import {
  encodeFabricValueDataURI,
  FABRIC_VALUE_DATA_URI_MEDIA_TYPE,
} from "../src/uri-utils.ts";
import { load } from "../src/storage/transaction/attestation.ts";

const address = (id: string) => ({
  id: id as `data:${string}`,
  type: "application/json" as const,
  scope: "space" as const,
});

function base64Utf8(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

Deno.test("storage data URI loader accepts legacy JSON and versioned Fabric values", () => {
  const legacy = load(address(
    `data:application/json,${
      encodeURIComponent(JSON.stringify({ value: "legacy" }))
    }`,
  ));
  assert(legacy.ok);
  assertEquals(legacy.ok.value, { value: "legacy" });

  const factory = createFactoryShell({
    kind: "handler",
    ref: {
      identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      symbol: "handler",
    },
    contextSchema: true,
    eventSchema: { type: "string" },
  });
  const fabric = load(address(encodeFabricValueDataURI(factory)));
  assert(fabric.ok);
  assert(isAdmittedFabricFactory(fabric.ok.value));
  assertEquals(factoryStateOf(fabric.ok.value), factoryStateOf(factory));
  assertThrows(
    () => (fabric.ok!.value as () => unknown)(),
    Error,
    "factory requires runner materialization",
  );
});

Deno.test("storage data URI loader decodes base64 as UTF-8", () => {
  const legacyText = JSON.stringify({ message: "Grüße 🌊" });
  const legacy = load(address(
    `data:application/json;charset=utf-8;base64,${base64Utf8(legacyText)}`,
  ));
  assert(legacy.ok);
  assertEquals(legacy.ok.value, { message: "Grüße 🌊" });

  const fabricText = 'fvj1:{"message":"Grüße 🌊"}';
  const fabric = load(address(
    `data:${FABRIC_VALUE_DATA_URI_MEDIA_TYPE};charset=utf8;base64,${
      base64Utf8(fabricText)
    }`,
  ));
  assert(fabric.ok);
  assertEquals(fabric.ok.value, { message: "Grüße 🌊" });
});

Deno.test("storage data URI loader preserves error classification", () => {
  const unsupported = load(address("data:application/jsonx,%7B%7D"));
  assertEquals(unsupported.error?.name, "UnsupportedMediaTypeError");

  const malformedFabric = load(address(
    `data:${FABRIC_VALUE_DATA_URI_MEDIA_TYPE},%7B%7D`,
  ));
  assertEquals(malformedFabric.error?.name, "InvalidDataURIError");

  const emptyLegacy = load(address("data:application/json,"));
  assertEquals(emptyLegacy.error?.name, "InvalidDataURIError");

  const missingComma = load(address("data:application/json"));
  assertEquals(missingComma.error?.name, "InvalidDataURIError");
});
