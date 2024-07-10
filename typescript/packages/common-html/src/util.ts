/** Is value an object? */
export const isObject = (value: any): value is object => {
  return value != null && typeof value === "object";
};

export const isString = (value: any): value is string => {
  return typeof value === "string";
}

export const noOp = () => {};