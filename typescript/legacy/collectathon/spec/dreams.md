## Feature: Dreams

Implement a new command in the tool, `dream <COLLECTION>`.

Similar to the `action` command, it will first determine the "shape" of data in the collection and then pass the shape + array of JSON records to an LLM that will "dream" a new item for the collection, based on the existing ones. The item should contain novel ideas or data but fit within the set it is part of.

Extract any shared functionality for schema/shape into "schema.ts", the dream logic goes in "dream.ts"

Return the files in full + the changes for the main.ts file.
