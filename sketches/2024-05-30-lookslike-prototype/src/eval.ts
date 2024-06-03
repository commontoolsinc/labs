export function prepare(code: string) {
  const func = new Function('system', 'inputs', code);
  return func;
}

function serializationBoundary(obj: any) {
  console.log('forwarding data', obj)
  return JSON.parse(JSON.stringify(obj));
}

export function run(func: Function, system: any, inputs: { [key: string]: any }) {
  return serializationBoundary(func(system, serializationBoundary(inputs)));
}
