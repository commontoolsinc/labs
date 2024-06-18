import {
  IO,
  Runtime,
  Dictionary,
  Value,
  infer,
  Input,
  LocalStorage,
  WASM_SANDBOX,
  SES_SANDBOX,
  CONFIDENTIAL_COMPUTE_SANDBOX,
} from '@commontools/runtime';

const EXAMPLE_MODULE_JS = `
import { read, write } from 'common:io/state@0.0.1';
import { titleCase } from 'https://deno.land/x/case/mod.ts';
// import 'https://deno.land/x/lodash@4.17.19/lodash.js';

export class Body {
    run() {
        console.log('Running!');

        const foo = read('foo');
        const value = foo?.deref();

        console.log('Value:', value);

        console.log('Setting some output...');

        write('baz', {
          tag: 'string',
          val: titleCase('bleep blorp')
          // val: _.identity('bleep blorp')
        });
    }
}

export const module = {
  Body,

  create() {
      console.log('Creating!');
      return new Body();
  }
};`;

const bar = {
  baz: 'quux',
};

export const demo = async () => {
  localStorage.clear();

  const rt = new Runtime();
  const storage = new LocalStorage();

  console.log('Instantiating the module');

  const module = await rt.eval(
    'example',
    WASM_SANDBOX,
    'text/javascript',
    EXAMPLE_MODULE_JS,
    new Input(storage, ['foo', 'baz'])
  );

  console.log(`Setting 'foo => bar' at the host level`);

  await storage.write('foo', infer('bar'));

  console.log('Running the module:');

  await module.run();

  const output = module.output(['baz']);

  console.log('Reading output in host thread:', await output.read('baz'));
};
