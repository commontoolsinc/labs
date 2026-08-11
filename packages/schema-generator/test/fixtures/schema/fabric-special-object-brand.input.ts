// Mirrors the api's `FabricSpecialObject` hierarchy. The brand key exists
// only in the type system -- no runtime value carries it -- so the generator
// must not surface it as a schema property or requirement.
//
// A concrete fabric-primitive class (`FabricBytes`) emits its
// fabric-primitive schema type (`{ type: "FabricBytes" }`, matched by
// prototype at validation time). A branded type OUTSIDE that vocabulary
// (the `FabricPrimitive` base here) still emits a structural object schema,
// with the brand skipped.
interface FabricSpecialObject {
  readonly "@commonfabric/FabricSpecialObject": true;
}

interface FabricPrimitive extends FabricSpecialObject {}

interface FabricBytes extends FabricPrimitive {
  readonly length: number;
  slice(start?: number, end?: number): Uint8Array;
  copyInto(target: Uint8Array, offset?: number, length?: number): number;
}

interface SchemaRoot {
  blob: FabricBytes;
  opaque: FabricPrimitive;
}
