export * from "./interface.ts";
export {
  jsTagFromValue,
  tagFromFabricPrimitive,
  tagFromFabricPrimitiveElseNull,
  tagFromFabricValue,
  tagFromFabricValueElseNull,
  tagFromNativeBuiltinClassElseNull,
  tagFromNativeValueElseNull,
} from "./impl.ts";
