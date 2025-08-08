# Client Transaction Shape (TypeScript)

```ts
type ChangeB64 = string;

type ReadAssert = {
  docId: string;
  branch: string;
  heads: string[];
};

type WriteEntry = {
  docId: string;
  branch: string;
  baseHeads: string[];
  changes: ChangeB64[];
  mergeOf?: { branch: string; heads: string[] }[];
};

type TxRequest = {
  clientTxId?: string;
  ucan: string;
  reads: ReadAssert[];
  writes: WriteEntry[];
  invariants?: { type: string; name?: string; params?: any }[];
  options?: { returnPatches?: boolean; returnHeads?: boolean };
};
