export function prepare(code: string) {
  const func = new Function('system', 'inputs', code);
  return func;
}

export function serializationBoundary(obj: any) {
  return JSON.parse(JSON.stringify(obj));
}

export function run(func: Function, system: any, inputs: { [key: string]: any }) {
  return serializationBoundary(func(system, serializationBoundary(inputs)));
}
