export function prepare(code: string) {
  const func = new Function('system', 'inputs', 'return async function() {' + code + '}');
  return func;
}

export function serializationBoundary(obj: any) {
  console.log('serializationBoundary', obj);
  return JSON.parse(JSON.stringify(obj));
}

export async function run(func: Function, system: any, inputs: { [key: string]: any }) {
  return serializationBoundary(await func(system, serializationBoundary(inputs))());
}
