export type LamportTime = number;

export const advanceClock = (...times: LamportTime[]) => Math.max(...times) + 1;
