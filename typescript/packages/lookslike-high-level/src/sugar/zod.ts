import { z } from "zod";

export const Ref = z.object({
  '/': z.instanceof(Uint8Array),
  multihash: z.object({
    digest: z.instanceof(Uint8Array),
    code: z.number(),
    length: z.number()
  }),
  bytes: z.instanceof(Uint8Array),
  version: z.literal(1),
  code: z.number(),
  toString: z.function(),
  toJSON: z.function().returns(z.object({ '/': z.string() }))
}).nullable().default(null);
export const UiFragment = z.any().nullable().default(null)
