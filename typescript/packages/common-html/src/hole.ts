export type Hole = {
  type: "hole";
  name: string;
};

export const create = (name: string): Hole => {
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

export const markup = (name: string) => `{{${name}}}`