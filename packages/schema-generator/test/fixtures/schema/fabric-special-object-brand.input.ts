// Mirrors the api's special-object classes. Their brand keys exist only in
// the type system -- no runtime value carries any of them -- so the generator
// must not surface one as a schema property or requirement.
//
// `FabricPrimitive` carries the brand that tells it from a `FabricInstance`;
// `FabricInstance` carries its own, plus the one that types a
// `FabricInstancePlus`, at `never`. A structural schema of either skips every
// such key.
//
// A concrete `FabricPrimitive` class (`FabricBytes`) emits its
// `FabricPrimitive` schema type (`{ type: "FabricBytes" }`, matched by
// prototype at validation time). A branded type OUTSIDE that vocabulary
// (the `FabricPrimitive` base here) still emits a structural object schema,
// with the brand skipped.
interface FabricPrimitive {
  readonly "@commonfabric/FabricPrimitive": true;
}

interface FabricInstance {
  readonly "@commonfabric/FabricInstance": true;
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
