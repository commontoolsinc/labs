import type { WriteTransaction } from "@rocicorp/reflect";

export const mutators = {
  increment,
  write
};

async function increment(tx: WriteTransaction, delta: number) {
  const value = (await tx.get<number>("count")) ?? 0;
  await tx.set("count", value + delta);
}

async function write(
  tx: WriteTransaction,
  { key, data }: { key: string; data: any }
) {
  await tx.set(key, data);
}
