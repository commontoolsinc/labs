import type { Database } from "@db/sqlite";

export type InvariantArgs = {
  db: Database;
  docId: string;
  branchId: string;
  seqNo: number;
  json: unknown;
};

export type InvariantFn = (args: InvariantArgs) => void;

const registry: InvariantFn[] = [];

export function registerInvariant(fn: InvariantFn): void {
  registry.push(fn);
}

export function clearInvariants(): void {
  registry.length = 0;
}

export function runInvariants(args: InvariantArgs): void {
  for (const fn of registry) fn(args);
}
