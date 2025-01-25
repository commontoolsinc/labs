import * as z from "zod";
import { describe, expect, it } from "vitest";
import { extractKeysFromZodSchema, zodSchemaToPlaceholder } from "../src/schema.js";

const schema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email()
});

const articleSchema = z.object({
  title: z.string(),
  author: z.string(),
  tags: z.array(z.string()),
})

const complexSchema = z.object({
  name: z.string().describe("Full name of the user"),
  age: z.number().describe("Age in years"),
  contact: z.object({
    email: z.string().email().describe("Primary email address"),
    phone: z.string().optional().describe("Contact phone number"),
    address: z.object({
      street: z.string(),
      city: z.string(),
      country: z.string()
    }).describe("Physical address")
  }),
  interests: z.array(z.object({
    category: z.string(),
    level: z.enum(["beginner", "intermediate", "expert"]),
    yearsExperience: z.number()
  })).describe("List of user interests")
});

describe("zodSchemaToPlaceholder", () => {
  it("should make a basic placeholder", () => {
    const expected = {
      "age": 0,
      "email": "string",
      "name": "string",
    };

    const output = zodSchemaToPlaceholder(schema);
    console.log(output);
    expect(output).toMatchObject(expected);
  })


  it("should make an article placeholder", () => {
    const expected = {
      "title": "string",
      "author": "string",
      "tags": ["string"]
    };

    const output = zodSchemaToPlaceholder(articleSchema);
    expect(output).toMatchObject(expected);
  })

  it("can list keys of a zod schema", () => {
    const keys = extractKeysFromZodSchema(articleSchema);
    expect(keys).toMatchObject(["title", "author", "tags"]);
  });

  it("should make a complex placeholder", () => {
      const expected = {
        "name": "string",
        "age": 0,
        "contact": {
          "email": "string",
          "phone": "string",
          "address": {
            "street": "string",
            "city": "string",
            "country": "string"
          }
        },
        "interests": [
          {
            "category": "string",
            "level": "beginner",
            "yearsExperience": 0
          }
        ]
      };

      const output = zodSchemaToPlaceholder(complexSchema);
      expect(output).toMatchObject(expected);
    })
});
