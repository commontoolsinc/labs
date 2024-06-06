import { IO, Runtime, Value, infer } from '@commontools/runtime';
console.log('wow')

const EXAMPLE_MODULE_JS = `
import { read, write } from 'common:io/state@0.0.1';

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

class LocalStorageIO implements IO {
  reset() {
    localStorage.clear();
  }

  read(key: string): Value | undefined {
    console.log(`Reading '${key}' from local storage`);
    let rawValue = localStorage.getItem(key);
    return infer(rawValue);
  }

  write(key: string, value: Value): void {
    console.log(`Writing '${key} => ${value.val}' to local storage`);
    // YOLO (don't do it this way actually)
    localStorage.setItem(key, value.val);
  }
}

export const demo = async () => {
  const rt = new Runtime();
  const io = new LocalStorageIO();

  io.reset();

  const module = await rt.eval('text/javascript', EXAMPLE_MODULE_JS, io);

  console.log(`Setting 'foo => bar' at the host level`);
  io.write('foo', infer('bar'));

  console.log('Running the module:');
  module.run();
};
