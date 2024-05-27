import { Runtime } from '@commontools/usuba-rt';

const COMMON_DIRECTORY_WIT = `
package common:directory;

interface lookup {
  entry: func(index: u32) -> string;
}

world directory {
  export lookup;
}`;

const EXAMPLE_HELLO_WIT = `
package example:hello;

world hello {
  import common:directory/lookup;

  export hello: func() -> string;
}`;

const EXAMPLE_HELLO_JS = `
import { entry } from 'common:directory/lookup';

export function hello() {
  let value = entry(Math.floor(Math.random() * 10));
  return 'Hello, Agent ' + value;
}`;

/**
 * Demo One
 */
export const demoOne = async () => {
  console.log('Initializing Runtime');

  const rt = new Runtime([COMMON_DIRECTORY_WIT]);

  console.log('Defining Module');

  type ExpectedExports = {
    hello: () => string;
  };

  const module = await rt.defineModule<ExpectedExports>({
    contentType: 'text/javascript',
    wit: EXAMPLE_HELLO_WIT,
    sourceCode: EXAMPLE_HELLO_JS,
  });

  console.log('Instantiating Module');

  const agents = [
    'Marnie',
    'Orange',
    'Frank',
    'Moon',
    'Sparrow',
    'River',
    'Archer',
    'Bard',
    'Helman',
    'Poisson',
  ];

  const { hello } = await module.instantiate({
    'common:directory/lookup': {
      entry(index: number) {
        return agents[Math.floor(index) % 10];
      },
    },
  });

  console.log('Invoking Module API:');

  console.log(`%c${hello()}`, 'font-size: 1.5em; font-weight: bold;');

  console.log('fin');
};

const COMMON_DIRECTORY_JS = `
const agents = [
  'Marnie',
  'Orange',
  'Frank',
  'Moon',
  'Sparrow',
  'River',
  'Archer',
  'Bard',
  'Helman',
  'Poisson',
];

export const lookup = {
  entry: (index) => agents[Math.floor(Math.random() * agents.length)]
};
`;

/**
 * Demo Two
 */
export const demoTwo = async () => {
  console.log('Initializing first Runtime');

  const rtOne = new Runtime([]);

  console.log('Defining first Module');

  type ExpectedExportsOne = {
    lookup: {
      entry(index: number): string;
    };
  };

  const moduleOne = await rtOne.defineModule<ExpectedExportsOne>({
    contentType: 'text/javascript',
    wit: COMMON_DIRECTORY_WIT,
    sourceCode: COMMON_DIRECTORY_JS,
  });

  const rtTwo = new Runtime([COMMON_DIRECTORY_WIT]);

  console.log('Defining second Module');

  type ExpectedExportsTwo = {
    hello: () => string;
  };

  const moduleTwo = await rtTwo.defineModule<ExpectedExportsTwo>({
    contentType: 'text/javascript',
    wit: EXAMPLE_HELLO_WIT,
    sourceCode: EXAMPLE_HELLO_JS,
  });

  console.log('Instantiating both Modules');

  const { hello } = await moduleTwo.instantiate({
    'common:directory/lookup': (await moduleOne.instantiate({})).lookup,
  });

  console.log('Invoking final Module API:');

  console.log(`%c${hello()}`, 'font-size: 1.5em; font-weight: bold;');

  console.log('fin');
};

/**
 * Demo Three
 */
const EXAMPLE_HELLO_PY = `
import random
import hello
from hello.imports import lookup

class Hello(hello.Hello):
    def hello(self) -> str:
        return "Hello, Agent %s!" % lookup.entry(random.randint(0, 9))
`;

export const demoThree = async () => {
  console.log('Initializing first Runtime');

  const rtOne = new Runtime([]);

  console.log('Defining first Module');

  type ExpectedExportsOne = {
    lookup: {
      entry(index: number): string;
    };
  };

  const moduleOne = await rtOne.defineModule<ExpectedExportsOne>({
    contentType: 'text/javascript',
    wit: COMMON_DIRECTORY_WIT,
    sourceCode: COMMON_DIRECTORY_JS,
  });

  const rtTwo = new Runtime([COMMON_DIRECTORY_WIT]);

  console.log('Defining second Module');

  type ExpectedExportsTwo = {
    hello: () => string;
  };

  const moduleTwo = await rtTwo.defineModule<ExpectedExportsTwo>({
    contentType: 'text/x-python',
    wit: EXAMPLE_HELLO_WIT,
    sourceCode: EXAMPLE_HELLO_PY,
  });

  console.log('Instantiating both Modules');

  const { hello } = await moduleTwo.instantiate({
    'common:directory/lookup': (await moduleOne.instantiate({})).lookup,
  });

  console.log('Invoking final Module API:');

  console.log(`%c${hello()}`, 'font-size: 1.5em; font-weight: bold;');

  console.log('fin');
};

(self as any).demoOne = demoOne;
(self as any).demoTwo = demoTwo;
(self as any).demoThree = demoThree;
