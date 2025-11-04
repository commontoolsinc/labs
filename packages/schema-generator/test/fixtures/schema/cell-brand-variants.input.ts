interface MyComparableCell<T> extends BrandedCell<T, "comparable"> {}
interface MyReadonlyCell<T> extends BrandedCell<T, "readonly"> {}
interface MyWriteonlyCell<T> extends BrandedCell<T, "writeonly"> {}
interface MyStream<T> extends BrandedCell<T, "stream"> {}
interface MyOpaque<T> extends BrandedCell<T, "opaque"> {}

interface SchemaRoot {
  comparableValue: MyComparableCell<number>;
  readonlyValue: MyReadonlyCell<string>;
  writeonlyValue: MyWriteonlyCell<boolean>;
  streamValue: MyStream<number>;
  opaqueValue: MyOpaque<boolean>;
}
