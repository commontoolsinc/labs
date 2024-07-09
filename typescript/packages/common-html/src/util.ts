/** Is value an object? */
export const isObject = (value: any): value is object => {
  return value != null && typeof value === "object";
};

export const noOp = () => {};