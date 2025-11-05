interface MyCell<T> extends BrandedCell<T, "cell"> {}
type OptionalCell = MyCell<number> | undefined;
type NullableCell = MyCell<string> | null;

interface SchemaRoot {
  maybeCell: OptionalCell;
  nullableCell: NullableCell;
}
