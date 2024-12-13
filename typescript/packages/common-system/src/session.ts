import { Reference } from "merkle-reference";
import { Instruction, Fact, refer } from "synopsys";

export type Store = Map<string, { version: number; value: unknown }>;

const references = new Map<string, Reference>();
const objects = new Map<string, any>();

export const cast = (entity: Reference, object: any) => {
  objects.set(entity.toString(), object);
  return entity;
};

export const resolve = <T extends unknown>(reference: Reference): T => {
  const object = objects.get(reference.toString());
  if (object !== undefined) {
    return object;
  } else {
    throw new RangeError(`Object for the ${reference} was not found`);
  }
};

export const upsert = ([entity, attribute, value]: Fact): Instruction => {
  const id = `${attribute}@${entity}`;
  let obsolete = references.get(id);
  const reference = refer(`${id}/${obsolete ?? ""}`);
  if (obsolete) {
    objects.delete(obsolete.toString());
  }
  objects.set(reference.toString(), value);
  references.set(id, reference);

  return {
    Upsert: [entity, attribute, reference],
  };
};

export const retract = ([entity, attribute, value]: Fact): Instruction => {
  const id = `${attribute}@${entity}`;
  let obsolete = references.get(id);
  if (obsolete) {
    objects.delete(obsolete.toString());
    references.delete(id);

    return {
      Retract: [entity, attribute, obsolete],
    };
  } else {
    return {
      Retract: [entity, attribute, value],
    };
  }
};
