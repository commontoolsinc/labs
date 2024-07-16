import {
  Runtime,
  Input,
  LocalStorage,
  WASM_SANDBOX,
  SES_SANDBOX
} from "@commontools/runtime";
import { EvalMode } from "./data.js";

export function prepare(code: string) {
  const func = new Function(
    "system",
    "inputs",
    "return async function() {" + code + "}"
  );
  return func;
}

export function serializationBoundary(obj: any) {
  console.log("serializationBoundary", obj);
  return JSON.parse(JSON.stringify(obj));
}

export async function run(
  id: string,
  src: string,
  inputs: { [key: string]: any },
  evalMode: EvalMode = "ses"
) {
  console.group("eval(" + id + ")");
  const rt = new Runtime();
  const storage = new LocalStorage();

  console.log("Instantiating the module");

  const module = await rt.eval(
    id,
    evalMode,
    "text/javascript",
    code(Object.keys(inputs), src),
    new Input(storage, Object.keys(inputs))
  );

  for (const key in inputs) {
    const value = inputs[key];
    if (value === null || value === undefined) {
      throw new Error(`Input ${key} is null or undefined`);
    }
    await storage.write(key, { tag: "string", val: JSON.stringify(value) });
  }

  console.log("Running the module:");
  await module.run();
  const output = module.output(["__result__"]);
  console.groupEnd();
  const returnValue = await output.read("__result__");
  if (!returnValue) {
    return null;
  }
  return JSON.parse(returnValue.value.val);
}

const code = (args: string[], src: string) => `
  import { read, write } from 'common:io/state@0.0.1';

  export class Body {
      run() {
          function input(key) {
              const ref = read(key);
              console.log('read(' + key + '):', ref);
              const value = ref?.deref()?.val;
              console.log('value(' + key + '):', value);
              return JSON.parse(value);
          }

          console.log('[begin]');
          const fn = ${src};
          const args = ${JSON.stringify(args)};
          const values = args.map(input);
          const result = fn(...values);
          write('__result__', { tag: 'string', val: JSON.stringify(result) });
          console.log('[end]');
      }
  }

  export const module = {
    Body,

    create() {
        console.log('Creating!');
        return new Body();
    }
  };`;
