import { expect } from "@std/expect";
import {
  createFactoryShell,
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import { UnknownValue } from "@commonfabric/data-model/fabric-instances";

import {
  decodeFactoryAwareIPCValue,
  encodeFactoryAwareIPCValue,
} from "./fabric-value-ipc.ts";

Deno.test("factory-aware IPC uses context-free Factory@1 codec projection", () => {
  const factory = createFactoryShell({
    kind: "module",
    ref: { identity: `${"B".repeat(42)}A`, symbol: "lift" },
    argumentSchema: { type: "number" },
    resultSchema: { type: "string" },
  });
  const encoded = encodeFactoryAwareIPCValue({ factory });

  expect(encoded.valueEncoding).toBe("fabric-json");
  expect(() => structuredClone(encoded)).not.toThrow();
  const decoded = decodeFactoryAwareIPCValue(
    encoded.value,
    encoded.valueEncoding,
  ) as { factory: unknown };
  expect(isAdmittedFabricFactory(decoded.factory)).toBe(true);
  expect(factoryStateOf(decoded.factory)).toEqual(factoryStateOf(factory));
  expect(() => (decoded.factory as () => void)()).toThrow(
    "factory requires runner materialization",
  );
});

Deno.test("factory-aware IPC never reinterprets an ordinary fvj1 string", () => {
  const authored = 'fvj1:{"/Factory@1":{"kind":"pattern"}}';
  const encoded = encodeFactoryAwareIPCValue(authored);

  expect(encoded).toEqual({ value: authored });
  expect(decodeFactoryAwareIPCValue(encoded.value, undefined)).toBe(authored);
});

Deno.test("factory-aware IPC finds factories in codec-backed instance state", () => {
  const factory = createFactoryShell({
    kind: "handler",
    ref: { identity: `${"D".repeat(42)}A`, symbol: "handler" },
    contextSchema: { type: "object" },
    eventSchema: { type: "string" },
  });
  const wrapped = new UnknownValue("FutureValue@1", { factory });

  const encoded = encodeFactoryAwareIPCValue(wrapped);

  expect(encoded.valueEncoding).toBe("fabric-json");
  expect(() => structuredClone(encoded)).not.toThrow();
  const decoded = decodeFactoryAwareIPCValue(
    encoded.value,
    encoded.valueEncoding,
  );
  expect(decoded).toBeInstanceOf(UnknownValue);
  const decodedFactory = (decoded as UnknownValue).state as {
    factory: unknown;
  };
  expect(isAdmittedFabricFactory(decodedFactory.factory)).toBe(true);
  expect(factoryStateOf(decodedFactory.factory)).toEqual(
    factoryStateOf(factory),
  );
});
