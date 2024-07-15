export type Hole = {
  type: "hole";
  name: string;
};

const holeNameRegex = /^(\w+)$/;

export const create = (name: string): Hole => {
  if (name.match(holeNameRegex) == null) {
    throw TypeError("Template hole names must be alphanumeric");
  }
  return {
    type: "hole",
    name,
  };
};

export const isHole = (value: unknown): value is Hole => {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Hole).type === "hole"
  );
};

export const markup = (name: string) => {
  if (name.match(holeNameRegex) == null) {
    throw TypeError("Template hole names must be alphanumeric");
  }
  return `{{${name}}}`;
};

const mustacheRegex = /{{(\w+)}}/g;

/** Parse mustaches in free text, returning an array of text and objects */
export const parse = (text: string) => {
  const result = [];
  let lastIndex = 0;
  let match: RegExpMatchArray | null = null;

  while ((match = mustacheRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }
    result.push(create(match[1]));
    lastIndex = mustacheRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result;
};
