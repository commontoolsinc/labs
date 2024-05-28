import { Runtime } from '@commontools/usuba-rt';

export const COMMON_DIRECTORY_WIT = `
package common:directory;

interface lookup {
  entry: func(index: u32) -> string;
}

world directory {
  export lookup;
}`;

export const EXAMPLE_HELLO_WIT = `
package example:hello;

world hello {
  import common:directory/lookup;

  export hello: func() -> string;
}`;

export const EXAMPLE_HELLO_JS = `
import { entry } from 'common:directory/lookup';

export function hello() {
  let value = entry(Math.floor(Math.random() * 10));
  return 'Hello, Agent ' + value;
}`;

export const demo = async () => {
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

  (self as any).demos ||= {};
  (self as any).demos.one = {
    hello,
  };
  console.log('fin');
};
