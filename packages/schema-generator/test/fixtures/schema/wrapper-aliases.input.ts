// Test wrapper type aliases - both direct and aliased wrapper types
// Using proper interface definitions that match actual CommonTools wrappers
type Default<T, V = T> = T;
interface Cell<T> extends BrandedCell<T, "cell"> {
  get(): T;
  set(v: T): void;
}
interface Stream<T> extends BrandedCell<T, "stream"> {
  subscribe(cb: (v: T) => void): void;
}

// Define wrapper aliases
type RecursiveItemArray = RecursiveItem[];
type DefaultRecursiveArray<T extends RecursiveItem[] = RecursiveItem[]> = Default<T, []>;
type CellRecursiveArray<T extends RecursiveItem[] = RecursiveItem[]> = Cell<T>;
type StreamRecursiveArray<T extends RecursiveItem[] = RecursiveItem[]> = Stream<
  T
>;

type RecursiveItem = {
  name: string;
  children?: RecursiveItem[];
};

interface SchemaRoot {
  // Direct wrapper usage
  directDefault: Default<RecursiveItem[], []>;
  directCell: Cell<RecursiveItem[]>;
  directStream: Stream<RecursiveItem[]>;

  // Aliased wrapper usage
  aliasedDefault: DefaultRecursiveArray;
  aliasedCell: CellRecursiveArray;
  aliasedStream: StreamRecursiveArray;
}
