// Mirrors the api's `FabricSpecialObject` hierarchy. The brand keys exist
// only in the type system -- no runtime value carries either -- so the
// generator must not surface one as a schema property or requirement.
//
// `FabricInstance` carries the second brand, the one that types a
// `FabricInstancePlus`, at `never`; a structural schema of it skips that key
// the same way.
//
// A concrete `FabricPrimitive` class (`FabricBytes`) emits its
// `FabricPrimitive` schema type (`{ type: "FabricBytes" }`, matched by
// prototype at validation time). A branded type OUTSIDE that vocabulary
// (the `FabricPrimitive` base here) still emits a structural object schema,
// with the brand skipped.
interface FabricSpecialObject {
  readonly "@commonfabric/FabricSpecialObject": true;
}

interface FabricPrimitive extends FabricSpecialObject {}

interface FabricInstance extends FabricSpecialObject {
  readonly "@commonfabric/FabricInstancePlus"?: never;
  deepClone(frozen: boolean): FabricInstance;
}

interface FabricBytes extends FabricPrimitive {
  readonly length: number;
  slice(start?: number, end?: number): Uint8Array;
  copyInto(target: Uint8Array, offset?: number, length?: number): number;
}

interface SchemaRoot {
  blob: FabricBytes;
  opaque: FabricPrimitive;
  instance: FabricInstance;
}
