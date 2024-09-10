import { addItemToCollection, getOrCreateCollection } from "./collections.ts";
import { db } from "./db.ts";
import { completion } from "./llm.ts";

export async function addRule(
  collectionName: string,
  rule: string,
  targetCollection: string
) {
  try {
    // Ensure both collections exist
    getOrCreateCollection(collectionName);
    getOrCreateCollection(targetCollection);

    const result = db.query(
      "INSERT INTO rules (collection_name, rule, target_collection) VALUES (?, ?, ?) RETURNING id",
      [collectionName, rule, targetCollection]
    );
    const ruleId = result[0][0] as number;
    console.log(
      `Added rule (ID: ${ruleId}) to collection "${collectionName}": "${rule}" -> "${targetCollection}"`
    );
  } catch (error) {
    console.error(`Error adding rule: ${error.message}`);
  }
}

export async function listRules(collectionName: string) {
  const rules = db.query<[number, string, string]>(
    "SELECT id, rule, target_collection FROM rules WHERE collection_name = ? ORDER BY id",
    [collectionName]
  );

  if (rules.length === 0) {
    console.log(`No rules found for collection: ${collectionName}`);
    return;
  }

  console.log(`Rules for collection "${collectionName}":`);
  for (const [id, rule, targetCollection] of rules) {
    console.log(`  ${id}: "${rule}" -> "${targetCollection}"`);
  }
}

export async function deleteRule(ruleId: number) {
  try {
    db.query("DELETE FROM rules WHERE id = ?", [ruleId]);
    console.log(`Deleted rule with ID: ${ruleId}`);
  } catch (error) {
    console.error(`Error deleting rule: ${error.message}`);
  }
}

export async function applyRules(collectionName: string, ruleId?: number) {
  let rules: [number, string, string][];

  if (ruleId) {
    rules = db.query<[number, string, string]>(
      "SELECT id, rule, target_collection FROM rules WHERE id = ?",
      [ruleId]
    );
    if (rules.length === 0) {
      console.error(`Rule with ID ${ruleId} not found`);
      return;
    }
  } else {
    rules = db.query<[number, string, string]>(
      "SELECT id, rule, target_collection FROM rules WHERE collection_name = ?",
      [collectionName]
    );
    if (rules.length === 0) {
      console.log(`No rules found for collection: ${collectionName}`);
      return;
    }
  }

  const items = db.query<[number, string, string]>(
    `SELECT i.id, i.content, i.raw_content 
     FROM items i
     JOIN item_collections ic ON i.id = ic.item_id
     JOIN collections c ON ic.collection_id = c.id
     WHERE c.name = ?`,
    [collectionName]
  );

  if (items.length === 0) {
    console.log(`No items found in collection: ${collectionName}`);
    return;
  }

  for (const [itemId, content, rawContent] of items) {
    for (const [ruleId, rule, targetCollection] of rules) {
      const systemPrompt =
        "You are an expert at evaluating content based on given criteria.";
      const userPrompt = `
Evaluate if the following content matches this rule: "${rule}"

Content:
${rawContent}

Respond with a JSON object of the form 

\`\`\`json
{ "match": true }
\`\`\` or
\`\`\`json
{ "match": false }
\`\`\`

Say NOTHING else.
`;

      const response = await completion(systemPrompt, [
        { role: "user", content: userPrompt },
      ]);

      if (response.match) {
        await addItemToCollection(itemId, targetCollection);
        console.log(
          `Rule ${ruleId} matched. Added item ${itemId} to collection "${targetCollection}"`
        );
      }
    }
  }
}
