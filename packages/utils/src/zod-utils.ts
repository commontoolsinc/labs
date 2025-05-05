/*
Vendored via https://github.com/colinhacks/zod/issues/2084
Usage:
```
export type UserModel = {
  id: string
  email: string | null
  name: string
  firstName: string
  createdAt: Date
}

export const UserCreateSchema = toZod<Omit<UserModel, "createdAt" | "id">>().with({
  email: z.string().email().nullable(),
  name: z.string(),
  firstName: z.string(),
});

export type UserCreatePayload = z.infer<typeof UserCreateSchema>
```
*/
import * as z from "zod";

type Implements<Model> = {
  [key in keyof Model]-?: undefined extends Model[key]
    ? null extends Model[key]
      ? z.ZodNullableType<z.ZodOptionalType<z.ZodType<Model[key]>>>
    : z.ZodOptionalType<z.ZodType<Model[key]>>
    : null extends Model[key] ? z.ZodNullableType<z.ZodType<Model[key]>>
    : z.ZodType<Model[key]>;
};

export function toZod<Model = never>() {
  return {
    with: <
      Schema extends
        & Implements<Model>
        & {
          [unknownKey in Exclude<keyof Schema, keyof Model>]: never;
        },
    >(
      schema: Schema,
    ) => z.object(schema),
  };
}
