import { Instruction, Reference } from "synopsys";

export type Store = Map<
  string,
  { local: number; remote: number; value: unknown }
>;

const store: Store = new Map();

export const resolve = (key: string) => store.get(key);

export const upsert = (
  entity: Reference,
  attribute: string,
  value: unknown,
) => {
  const changes = [] as Instruction[];
  const id = `${attribute}@${entity}`;
  let state = store.get(id);
  if (state) {
    state.local++;
    state.value = value;
  } else {
    state = { local: 1, remote: 1, value };
    store.set(id, state);
  }
  state.remote = state.local;

  changes.push({
    Upsert: [entity, attribute, `${id}:${state.remote}`],
  });
  return changes;
};

export const retract = (entity: Reference, attribute: string, value: any) => {
  const changes = [] as Instruction[];
  const id = `${attribute}@${entity}`;
  const state = store.get(id);
  if (state) {
    changes.push({
      Retract: [entity, attribute, `${id}:${state.remote}`],
    });
    state.local++;
    state.remote = state.local;
  } else {
    changes.push({ Retract: [entity, attribute, value] });
  }
  return changes;
};
