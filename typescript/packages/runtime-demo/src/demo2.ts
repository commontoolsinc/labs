import { Runtime } from '@commontools/usuba-rt';

export const COMMON_ITERATOR_WIT = `
package common:iterator;

interface iterator {
  variant value {
    %string(string),
    number(f64),
    boolean(bool),
    buffer(list<u8>)
  }

  resource iterable {
    next: func() -> option<iterable>;
    value: func() -> option<value>;
  }

  create: func() -> iterable;
}

world common {
  export iterator;
}`;

export const USER_MODULE_JS = `
class Iterable {
  #iter;
  #value;

  constructor(iter) {
    this.#iter = iter;
    this.#value = iter.next();
  }

  next() {
    this.#value = this.#iter.next();
    if (this.#value.done) {
      return;
    }
    return this;
  }

  value() {
    return {
      tag: 'number',
      val: this.#value.value
    };
  }
}

function *doWork() {
  for (let i = 0; i < 10; ++i) {
    yield i;
  }
}

export const iterator = {
  Iterable,
  create() {
    const i = new Iterable(doWork());
    console.log('Doing work', i);
    return new Iterable(doWork());
  }
};`;

export const demo = async () => {
  console.log('Initializing Runtime');

  const rt = new Runtime([]);

  console.log('Defining Module');

  type Value =
    | {
        tag: 'number';
        val: number;
      }
    | {
        tag: 'string';
        val: string;
      }
    | {
        tag: 'boolean';
        val: boolean;
      }
    | {
        tag: 'buffer';
        val: Uint8Array;
      };
  interface Iterator {
    next(): Iterator | void;
    value(): Value | void;
  }
  type ExpectedExports = {
    iterator: {
      create: () => Iterator;
    };
  };

  const module = await rt.defineModule<ExpectedExports>({
    contentType: 'text/javascript',
    wit: COMMON_ITERATOR_WIT,
    sourceCode: USER_MODULE_JS,
  });

  console.log('Instantiating Module');

  const {
    iterator: { create: createIterator },
  } = await module.instantiate({});

  console.log('Invoking Module API:');

  for (
    let iterator: Iterator | void = createIterator();
    iterator;
    iterator = iterator.next()
  ) {
    console.log(
      `%cValue: ${iterator?.value()?.val}`,
      'font-size: 1.5em; font-weight: bold;'
    );
  }

  (self as any).demos ||= {};
  (self as any).demos.four = {
    createIterator,
  };
  console.log('fin');
};
