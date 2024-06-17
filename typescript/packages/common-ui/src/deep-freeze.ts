/** Deep freeze an object */
export const deepFreeze = <T extends object>(obj: T): T => {
  // Retrieve the property names defined on object
  const propNames = Reflect.ownKeys(obj);

  // Freeze properties before freezing self
  for (const name of propNames) {
    // @ts-ignore
    const value = obj[name];

    if ((value && typeof value === "object") || typeof value === "function") {
      deepFreeze(value);
    }
  }

  return Object.freeze(obj);
}

export default deepFreeze;