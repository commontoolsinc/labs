export interface GoldenCase {
  name: string;
  code: string;
  typeName: string;
  expectedPath: string;
}

export const GOLDEN_CASES: GoldenCase[] = [
  {
    name: "recursion_basic",
    code: `interface Node { value: number; next?: Node; }`,
    typeName: "Node",
    expectedPath: "./test/golden/expected/recursion_basic.json",
  },
  {
    name: "recursion_children_array",
    code: `interface Node { value: string; children?: Node[] }`,
    typeName: "Node",
    expectedPath: "./test/golden/expected/recursion_children_array.json",
  },
  {
    name: "wrappers_nested",
    code: `
      interface Default<T,V> {}
      interface Cell<T> { get(): T; set(v: T): void; }
      interface X {
        cellOfDefault: Cell<Default<string, "d">>;
        defaultArray: Default<string[], ["a", "b"]>;
      }
    `,
    typeName: "X",
    expectedPath: "./test/golden/expected/wrappers_nested.json",
  },
  {
    name: "defaults_complex_array_object",
    code: `
      interface Default<T,V> {}
      interface TodoItem { title: string; done: boolean; }
      interface WithArrayDefaults {
        emptyItems: Default<TodoItem[], []>;
        prefilledItems: Default<string[], ["item1", "item2"]>;
        matrix: Default<number[][], [[1,2],[3,4]]>;
      }
      interface WithObjectDefaults {
        config: Default<{ theme: string; count: number }, { theme: "dark"; count: 10 }>;
        user: Default<{ name: string; settings: { notifications: boolean; email: string } }, { name: "Anonymous"; settings: { notifications: true; email: "user@example.com" } }>;
      }
    `,
    typeName: "WithArrayDefaults",
    expectedPath: "./test/golden/expected/defaults_complex_array.json",
  },
  {
    name: "defaults_complex_object_only",
    code: `
      interface Default<T,V> {}
      interface WithObjectDefaults {
        config: Default<{ theme: string; count: number }, { theme: "dark"; count: 10 }>;
        user: Default<{ name: string; settings: { notifications: boolean; email: string } }, { name: "Anonymous"; settings: { notifications: true; email: "user@example.com" } }>;
      }
    `,
    typeName: "WithObjectDefaults",
    expectedPath: "./test/golden/expected/defaults_complex_object.json",
  },
  {
    name: "cycles_multi_hop",
    code: `
      interface A { b: B }
      interface B { c: C }
      interface C { a: A }
    `,
    typeName: "A",
    expectedPath: "./test/golden/expected/cycles_multi_hop.json",
  },
  {
    name: "cycles_mutual_optional",
    code: `
      interface A { b?: B }
      interface B { a?: A }
    `,
    typeName: "A",
    expectedPath: "./test/golden/expected/cycles_mutual_optional.json",
  },
  {
    name: "aliases_of_aliases_cell_array",
    code: `
      interface Cell<T> { get(): T; set(v: T): void; }
      type CellArray<T> = Cell<T[]>;
      type Alias2<T> = CellArray<T>;
      interface X { values: Alias2<number>; }
    `,
    typeName: "X",
    expectedPath: "./test/golden/expected/aliases_of_aliases_cell_array.json",
  },
  {
    name: "array_of_cell_string",
    code: `
      interface Cell<T> { get(): T; set(v: T): void; }
      interface X { items: Cell<string>[]; }
    `,
    typeName: "X",
    expectedPath: "./test/golden/expected/array_of_cell_string.json",
  },
  {
    name: "stream_of_cell_number",
    code: `
      interface Cell<T> { get(): T; set(v: T): void; }
      interface Stream<T> { subscribe(cb: (v:T)=>void): void }
      interface X { stream: Stream<Cell<number>>; }
    `,
    typeName: "X",
    expectedPath: "./test/golden/expected/stream_of_cell_number.json",
  },
  {
    name: "default_nullable_null",
    code: `
      interface Default<T,V> {}
      interface X { maybe: Default<string | null, null>; }
    `,
    typeName: "X",
    expectedPath: "./test/golden/expected/default_nullable_null.json",
  },
];
