import { Runtime } from '@commontools/usuba-rt';
import { COMMON_DIRECTORY_WIT, EXAMPLE_HELLO_WIT } from './demo1.js';
import { COMMON_DIRECTORY_JS } from './demo3.js';

export const EXAMPLE_HELLO_PY = `
import random
import hello
from hello.imports import lookup

class Hello(hello.Hello):
    def hello(self) -> str:
        return "Hello, Agent %s!" % lookup.entry(random.randint(0, 9))
`;

export const demo = async () => {
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
  (self as any).demos ||= {};
  (self as any).demos.three = {
    hello,
  };
  console.log('fin');
};
