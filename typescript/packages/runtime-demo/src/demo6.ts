import { IO, Runtime, Dictionary, Value, infer } from '@commontools/runtime';

const EXAMPLE_MODULE_JS = `
import { read, write } from 'common:io/state@0.0.1';

export class Body {
    run() {
        console.log('Running!');

        const foo = read('foo');
        const value = foo?.deref();

        console.log('Value:', value);

        const bar = read('bar');
        const dict = bar?.deref()?.val;
        const dictValue = dict.get('baz');

        console.log('Dictionary value:', dictValue.deref()?.val);
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

class LocalStorageIO implements IO {
  reset() {
    localStorage.clear();
  }

  read(key: string): Value | undefined {
    if (key == 'bar') {
      console.log(`Reading special key '${key}'...`);
      return infer(bar);
    }

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
