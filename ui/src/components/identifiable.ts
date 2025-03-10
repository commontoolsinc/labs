export type Identifiable = {
  id: string;
};

export const getId = (identifiable: Identifiable) => identifiable.id;
