const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encode = (input: string): Uint8Array => encoder.encode(input);
export const decode = (input: Uint8Array): string => decoder.decode(input);
