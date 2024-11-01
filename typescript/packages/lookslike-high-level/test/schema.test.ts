import * as z from "zod";
import { describe, expect, it } from "vitest";
import { extractKeysFromZodSchema, jsonToDatalogQuery, zodSchemaToPlaceholder } from "../src/schema.js";

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

const articleWithCommentsSchema = z.object({
  title: z.string(),
  author: z.string(),
  comments: z.array(z.object({
    message: z.string()
  }))
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

  it("should make an article query", () => {
    const expected = {
      select: {
        title: "?title",
        author: "?author",
        tags: ["?tags"]
      },
      where: [
        { Case: ["?item", "title", "?title"] },
        { Case: ["?item", "author", "?author"] },
        { Case: ["?item", "tags", "?tags[]"] },
        { Case: ["?tags[]", "?[tags]", "?tags"] }
      ]
    };

    const output = zodSchemaToPlaceholder(articleSchema);
    const query = jsonToDatalogQuery(output);
    expect(query).toMatchObject(expected);
  })

  it("should make an article with comments query", () => {
    const expected = {
      select: {
        title: "?title",
        author: "?author",
        comments: [{
          message: "?comments_message"
        }]
      },
      where: [
        { Case: ["?item", "title", "?title"] },
        { Case: ["?item", "author", "?author"] },
        { Case: ["?item", "comments", "?comments[]"] },
        { Case: ["?comments[]", "?[comments]", "?comments"] },
        { Case: ["?comments", "message", "?comments_message"] }
      ]
    };

    const output = zodSchemaToPlaceholder(articleWithCommentsSchema);
    const query = jsonToDatalogQuery(output);
    expect(query).toMatchObject(expected);
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

describe("jsonToDatalogQuery", () => {
  it("should make a basic query", () => {
    const expected = {
      select: {
        item: [{
          id: "?item",
          name: "?name",
          age: "?age",
          email: "?email",
        }]
      },
      where: expect.arrayContaining([
        { Case: ["?item", "name", "?name"] },
        { Case: ["?item", "age", "?age"] },
        { Case: ["?item", "email", "?email"] },
      ]),
    };

    const output = jsonToDatalogQuery({
      "age": 0,
      "email": "string",
      "name": "string",
    });
    expect(output).toMatchObject(expected);
  })

  it("should handle nested objects", () => {
    const expected = {
      select: {
        item: [{
          id: "?item",
          name: "?name",
          address: {
            street: "?address_street",
            city: "?address_city",
          }
        }]
      },
      where: expect.arrayContaining([
        { Case: ["?item", "name", "?name"] },
        { Case: ["?item", "address/street", "?address_street"] },
        { Case: ["?item", "address/city", "?address_city"] },
      ]),
    };

    const output = jsonToDatalogQuery({
      "name": "string",
      "address": {
        "street": "string",
        "city": "string"
      }
    });
    expect(output).toMatchObject(expected);
  })

  it("should handle lists", () => {
    const expected = {
      select: {
        item: [{
          id: "?item",
          name: "?name",
          favourites: [{ name: "?favourites_name" }]
        }]
      },
      where: expect.arrayContaining([
        { Case: ["?item", "name", "?name"] },
        { Case: ["?item", "favourites/name", "?favourites_name"] }
      ]),
    };

    const output = jsonToDatalogQuery({
      "name": "string",
      "favourites": [
        {
          "name": "string"
        }
      ]
    });
    expect(output).toMatchObject(expected);
  })

  it("should handle complex schema", () => {
      const expected = {
        select: {
          item: [{
            id: "?item",
            name: "?name",
            age: "?age",
            contact: {
              email: "?contact_email",
              phone: "?contact_phone",
              address: {
                street: "?contact_address_street",
                city: "?contact_address_city",
                country: "?contact_address_country"
              }
            },
            interests: [{
              category: "?interests_category",
              level: "?interests_level",
              yearsExperience: "?interests_yearsExperience"
            }]
          }]
        },
        where: expect.arrayContaining([
          { Case: ["?item", "name", "?name"] },
          { Case: ["?item", "age", "?age"] },
          { Case: ["?item", "contact/email", "?contact_email"] },
          { Case: ["?item", "contact/phone", "?contact_phone"] },
          { Case: ["?item", "contact/address/street", "?contact_address_street"] },
          { Case: ["?item", "contact/address/city", "?contact_address_city"] },
          { Case: ["?item", "contact/address/country", "?contact_address_country"] },
          { Case: ["?item", "interests/category", "?interests_category"] },
          { Case: ["?item", "interests/level", "?interests_level"] },
          { Case: ["?item", "interests/yearsExperience", "?interests_yearsExperience"] }
        ]),
      };

      const placeholder = zodSchemaToPlaceholder(complexSchema);
      const output = jsonToDatalogQuery(placeholder);
      expect(output).toMatchObject(expected);
    })
});
