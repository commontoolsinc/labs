import { Runtime } from '@commontools/usuba-rt';
import { wit as commonModuleWit } from '@commontools/module';
import { wit as commonDataWit } from '@commontools/data';
import { wit as commonIoWit } from '@commontools/io';

const EXAMPLE_MODULE_JS = `
import { read } from 'common:io/state@0.0.1';

export class Body {
    run() {
        console.log('Running!');
        const foo = read('foo');
        console.log('Reference:', foo);
        const value = foo?.deref();
        console.log('Value:', value);
    }
}

export const module = {
  Body,

  create() {
      console.log('Creating!');
      return new Body();
  }
};`;

export const demo = async () => {
  const runtime = new Runtime([commonDataWit, commonIoWit]);

  console.log(Runtime);

  const module = await runtime.defineModule({
    contentType: 'text/javascript',
    wit: commonModuleWit,
    sourceCode: EXAMPLE_MODULE_JS,
  });

  class Reference {
    #value: any;
    constructor(value: any) {
      this.#value = value;
    }
    deref() {
      return this.#value;
    }
  }

  const theOnlyReference = new Reference({
    tag: 'string',
    val: 'WOOT',
  });

  const api = await module.instantiate({
    'common:data/types': {
      Map: Map,
      Reference,
    },
    'common:io/state': {
      Stream: class Stream {
        next() {
          console.log('Not implemented!');
        }
      },
      read(name: string) {
        return theOnlyReference;
      },
      write(_name: string, _value: any) {
        console.log('Write ignored!');
      },
      subscribe(_name: string) {
        console.log('Subscribe ignored!');
      },
    },
  });
  const {
    module: { create },
  }: any = api;

  console.log(api, create);

  const body = create();

  body.run();
  body.run();
  body.run();
  body.run();
  body.run();

  console.log('FIN');
};
