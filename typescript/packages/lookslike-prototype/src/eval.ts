import { IO, Runtime, Value, infer } from '@commontools/runtime';

export function prepare(code: string) {
  const func = new Function('system', 'inputs', 'return async function() {' + code + '}');
  return func;
}

export function serializationBoundary(obj: any) {
  console.log('serializationBoundary', obj);
  return JSON.parse(JSON.stringify(obj));
}

export async function run(src: string, inputs: { [key: string]: any }) {
  const rt = new Runtime();
  const io = new ProxyIO(inputs);

  io.reset();

  const module = await rt.eval('text/javascript', code(src), io);

  for (const key in inputs) {
    io.write(key, infer(inputs[key]));
  }

  console.log('Running the module:');
  module.run();
  const returnValue = io.read('__result__');
  return returnValue?.val;
}


const code = (src: string) => `
  import { read, write } from 'common:io/state@0.0.1';

  export class Body {
      run() {
          function input(key) {
              const ref = read(key);
              console.log('Reference:', ref);
              const value = ref?.deref()?.val;
              console.log('Value:', value);
              return value;
          }

          console.log('Running!');
          debugger;
          const fn = ${src};
          const result = fn();
          write('__result__', { tag: 'string', val: result });
      }
  }

  export const module = {
    Body,

    create() {
        console.log('Creating!');
        return new Body();
    }
  };`

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

class ProxyIO implements IO {
  private inputs: { [key: string]: any };

  constructor(inputs: { [key: string]: any }) {
    this.inputs = inputs;
  }

  reset() { }

  read(key: string): Value | undefined {
    console.log(`Reading '${key}' from inputs`);
    const val = infer(this.inputs[key]);
    return val;
  }

  write(key: string, value: Value): void {
    console.log(`Writing '${key} => ${value.val}' to inputs`);
    this.inputs[key] = value.val;
  }
}

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
