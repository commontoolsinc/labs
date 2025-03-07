const freeze = Object.freeze;

export const model = ({ id, text }: { id: string; text: string }) =>
  freeze({
    id,
    text,
  });

export type Model = ReturnType<typeof model>;
