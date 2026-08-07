import { type FabricBytes, pattern, UI } from "commonfabric";

// FIXTURE: fabric-special-object-brand
// Verifies: the `FabricSpecialObject` nominal brand -- a type-system-only key
// on `FabricBytes` and the other fabric special objects -- never reaches a
// generated schema's `properties` or `required`.
export default pattern((state: { blob: FabricBytes }) => {
  return {
    [UI]: <div>has bytes</div>,
  };
});
