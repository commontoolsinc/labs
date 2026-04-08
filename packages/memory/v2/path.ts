export const parsePointer = (path: string): string[] => {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${path}`);
  }
  return path.slice(1).split("/").map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  );
};

export const encodePointer = (path: readonly string[]): string => {
  return path.length === 0
    ? ""
    : `/${
      path.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/")
    }`;
};

export const isPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean => {
  if (prefix.length > path.length) {
    return false;
  }
  return prefix.every((segment, index) => path[index] === segment);
};

export const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => isPrefixPath(left, right) || isPrefixPath(right, left);

export const parentPath = (path: readonly string[]): string[] => {
  return path.length === 0 ? [] : [...path.slice(0, -1)];
};
