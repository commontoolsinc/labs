export const isIterable = (value: any): value is Iterable<any> => {
  return value && typeof value[Symbol.iterator] === "function";
}

export function* gmap<T, U>(
  iterable: Iterable<T>,
  transform: (value: T) => U
) {
  for (const value of iterable) {
    yield transform(value);
  }
}