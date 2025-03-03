type Paths<T, Path extends string[] = []> = {
  [K in keyof T & string]: T[K] extends object ? Paths<T[K], [K]>
    : [...Path, K];
};

interface Example {
  foo: string;
  bar: {
    baz: number;
    qux: {
      quux: boolean;
      nested: {
        value: string;
      };
    };
  };
  deep: {
    a: {
      b: {
        c: number;
      };
    };
  };
}

type EPath = Paths<Example>;
