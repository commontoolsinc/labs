export type Shard = {
  index: number;
  total: number;
};

export function parseShard(raw: string): Shard {
  const match = raw.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/);
  if (!match) {
    throw new Error(`Expected shard argument like 1/4, got: ${raw}`);
  }

  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total)) {
    throw new Error(`Shard values must be safe integers, got: ${raw}`);
  }
  if (index > total) {
    throw new Error(`Shard index ${index} exceeds total shard count ${total}`);
  }

  return { index, total };
}
