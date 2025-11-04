declare const CELL_BRAND: unique symbol;

interface BrandedCell<T, Brand extends string> {
  readonly [CELL_BRAND]: Brand;
}

interface ComparableCell<T> extends BrandedCell<T, "comparable"> {}
interface ReadonlyCell<T> extends BrandedCell<T, "readonly"> {}
interface WriteonlyCell<T> extends BrandedCell<T, "writeonly"> {}
interface CustomStream<T> extends BrandedCell<T, "stream"> {}
interface CustomOpaque<T> extends BrandedCell<T, "opaque"> {}

interface SchemaRoot {
  comparableValue: ComparableCell<number>;
  readonlyValue: ReadonlyCell<string>;
  writeonlyValue: WriteonlyCell<boolean>;
  streamValue: CustomStream<number>;
  opaqueValue: CustomOpaque<boolean>;
}
