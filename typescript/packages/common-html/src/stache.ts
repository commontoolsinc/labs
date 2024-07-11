import { create as createHole } from './hole.js';

const mustacheRegex = /{{(\w+)}}/g;

/** Parse mustaches in free text, returning an array of text and objects */
export const parseMustaches = (text: string) => {
  const result = [];
  let lastIndex = 0;
  let match: RegExpMatchArray | null = null;

  while ((match = mustacheRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }
    result.push(createHole(match[1]));
    lastIndex = mustacheRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result;
};

export default parseMustaches;
