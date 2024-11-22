import { Instruction, Reference } from "@commontools/common-system";

export function assert(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Assert: [self, k, v] } as Instruction));
}

export function set(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Upsert: [self, k, v] } as Instruction));
}

export function remove(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Retract: [self, k, v] } as Instruction));
}
