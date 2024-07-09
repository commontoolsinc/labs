/**
 * Create a memoized 1-arg function that will retrieve cached results when
 * called with the same argument.
 * @returns A memoized version of the input function.
 * @example
 * const cachedFunction = memoize((n: number) => { ... })
 * cachedFunction(1) // Performs calculation for 1
 * cachedFunction(1) // Returns cached result for 1
 * cachedFunction.clear() // Clears the cache
 */
export const memoize = <T, U>(func: (props: T) => U) => {
  const cache = new Map<T, U>();
  const getCached = (props: T): U => {
    if (!cache.has(props)) {
      cache.set(props, func(props));
    }
    return cache.get(props)!;
  };
  getCached.clear = () => cache.clear();
  return getCached;
};

export default memoize;