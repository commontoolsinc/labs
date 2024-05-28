import { Runtime } from '@commontools/usuba-rt';
import {
  COMMON_DIRECTORY_WIT,
  EXAMPLE_HELLO_WIT,
  EXAMPLE_HELLO_JS,
} from './demo1.js';

export const COMMON_DIRECTORY_JS = `
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

  (self as any).demos ||= {};
  (self as any).demos.two = {
    hello,
  };

  console.log('fin');
};
