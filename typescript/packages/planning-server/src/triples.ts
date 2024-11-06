// main.ts
import { datascript } from "./deps.ts";

// Define the schema
const schema = {
  "note/tag": { ":db/cardinality": ":db.cardinality/many" },
  "note/content": { ":db/cardinality": ":db.cardinality/many" },
};

// Create a connection
const conn = datascript.create_conn(schema);

// Define the data
const noteData = [
  {
    ":db/id": -1,
    "note/timestamp": new Date("2024-06-20T17:16:00-07:00"),
    "note/location": "Berkely, California",
    "note/weather": "18C, Sunny",
    "note/scope": "work",
    "note/author": "user",
    "note/tag": ["work", "demoscene", "vega-lite"],
    "note/content": [
      "created a UI for rendering 2D grids using vega-lite",
      "tied it to a clock for realtime graphics",
    ],
    "note/connection": "user enjoys computer graphics demos",
    "note/question": "how can we achieve other interesting animations?",
    "note/dimensions": [10, 10],
    "note/request":
      "create a clock node, pipe it into a code node to make a 2d grid of values based on Math.sin of the current tick value and then visualize it as a heatmap using vega-lite (declare the spec in a code node)",
  },
  {
    ":db/id": -2,
    "note/timestamp": new Date("2024-07-03T10:23:00-04:00"),
    "note/location": "New York City, New York",
    "note/weather": "28C, Partly Cloudy",
    "note/scope": "personal",
    "note/author": "user",
    "note/tag": ["cooking", "molecular-gastronomy", "experiment"],
    "note/content": [
      "attempted spherification of mango puree using sodium alginate",
      "achieved stable spheres but flavor was muted",
    ],
    "note/connection": "user is exploring advanced culinary techniques",
    "note/question": "how can we enhance flavor while maintaining texture?",
    "note/ingredients": ["mango puree", "sodium alginate", "calcium lactate"],
    "note/request":
      "research methods to intensify fruit flavors without compromising molecular gastronomy techniques, focus on natural flavor enhancers and concentration methods",
  },
  {
    ":db/id": -3,
    "note/timestamp": new Date("2024-08-15T15:45:00Z"),
    "note/location": "London, UK",
    "note/weather": "22C, Overcast",
    "note/scope": "research",
    "note/author": "user",
    "note/tag": ["quantum-computing", "error-correction", "simulation"],
    "note/content": [
      "ran simulation of surface code error correction on 100-qubit system",
      "achieved 99.9% fidelity but runtime exceeded expectations",
    ],
    "note/connection": "user is working on quantum computing challenges",
    "note/question": "how can we optimize the simulation for faster runtime?",
    "note/qubits": 100,
    "note/error_rate": 0.001,
    "note/request":
      "analyze current simulation algorithm, identify bottlenecks, and propose optimizations. Consider parallel processing and more efficient error syndrome decoding methods.",
  },
  {
    ":db/id": -4,
    "note/timestamp": new Date("2024-09-02T09:07:00+09:00"),
    "note/location": "Tokyo, Japan",
    "note/weather": "30C, Humid",
    "note/scope": "hobby",
    "note/author": "user",
    "note/tag": ["bonsai", "horticulture", "miniature-landscapes"],
    "note/content": [
      "created a miniature forest scene using five Shimpaku junipers",
      "struggling with scale representation of distant trees",
    ],
    "note/connection": "user is passionate about bonsai art",
    "note/question":
      "what techniques can improve depth perception in miniature landscapes?",
    "note/trees": ["Shimpaku juniper", "Japanese maple", "Chinese elm"],
    "note/request":
      "research advanced bonsai techniques for creating depth illusion in small spaces, focus on foliage density manipulation and strategic placement of accent plants",
  },
];

// Transact the data
datascript.transact(conn, noteData);

// Query functions
function getAllNotes() {
  const query = `
    [:find ?e ?timestamp ?location ?weather ?scope ?author
     :where
     [?e "note/timestamp" ?timestamp]
     [?e "note/location" ?location]
     [?e "note/weather" ?weather]
     [?e "note/scope" ?scope]
     [?e "note/author" ?author]]
  `;
  return datascript.q(query, datascript.db(conn));
}

function getNotesByTag(tag: string) {
  const query = `
    [:find ?e ?content
     :where
     [?e "note/tag" "${tag}"]
     [?e "note/content" ?content]]
  `;
  return datascript.q(query, datascript.db(conn));
}
function getNotesFromPastDays(days: number) {
  const currentDate = new Date();
  const pastDate = new Date(currentDate.getTime() - days * 24 * 60 * 60 * 1000);

  const query = `
    [:find ?e ?timestamp ?content
     :where
     [?e "note/timestamp" ?timestamp]
     [?e "note/content" ?content]
     [(>= ?timestamp #inst "${pastDate.toISOString()}")]]
  `;
  return datascript.q(query, datascript.db(conn));
}

// Run queries and log results
console.log("All Notes:");
console.log(getAllNotes());

console.log("\nNotes with 'work' tag:");
console.log(getNotesByTag("work"));

// New query execution
console.log("\nNotes from the past 7 days:");
console.log(getNotesFromPastDays(7));

function findRelatedMemories(tags: string[]) {
  const query = `
    [:find ?e ?tag
     :in $ [?searchTags ...]
     :where
     [?e "note/tag" ?tag]
     [(contains? ?searchTags ?tag)]]
  `;
  const result = datascript.q(query, datascript.db(conn), tags);
  console.log("Query result:", result);
  console.log("Search tags:", tags);
  return result;
}

function getAllTags() {
  const query = `
    [:find ?tag
     :where
     [_ "note/tag" ?tag]]
  `;
  return datascript.q(query, datascript.db(conn));
}

function getAllNotesWithTags() {
  const query = `
    [:find ?e ?timestamp (pull ?e ["note/tag"])
     :where
     [?e "note/timestamp" ?timestamp]]
  `;
  return datascript.q(query, datascript.db(conn));
}

async function storeMemoryWithConnections(newMemory: any) {
  // Step 1: Query for related memories
  const relatedMemoriesQuery = `
    [:find ?e ?tag
     :in $ [?searchTags ...]
     :where
     [?e "note/tag" ?tag]
     [(contains? ?searchTags ?tag)]]
  `;

  const relatedMemories = datascript.q(
    relatedMemoriesQuery,
    datascript.db(conn),
    newMemory["note/tag"],
  );

  console.log("Related Memories:", relatedMemories);

  // Step 2: Store the new memory
  const txReport = datascript.transact(conn, [newMemory]);

  // Query for the ID of the newly inserted entity
  const newMemoryIdQuery = `
    [:find ?e .
     :in $ ?timestamp
     :where 
     [?e "note/timestamp" ?timestamp]]
  `;
  const newMemoryId = datascript.q(
    newMemoryIdQuery,
    datascript.db(conn),
    newMemory["note/timestamp"],
  );

  console.log("New Memory ID:", newMemoryId);

  // Step 3: Create connections
  const connections = relatedMemories.map(([relatedId, matchingTag]) => ({
    "connection/from": newMemoryId,
    "connection/to": relatedId,
    "connection/type": "tag",
    "connection/tag": matchingTag,
  }));

  console.log("Connections to be created:", connections);

  if (connections.length > 0) {
    datascript.transact(conn, connections);
  } else {
    console.log("No connections created.");
  }

  return newMemoryId;
}

const newDoc = {
  "note/timestamp": new Date("2025-07-08T14:30:00+10:00"),
  "note/location": "Sydney, Australia",
  "note/weather": "22C, Partly cloudy",
  "note/scope": "professional",
  "note/author": "user",
  "note/tag": [
    "marine-biology",
    "coral-restoration",
    "great-barrier-reef",
    "bonsai",
  ],
  "note/content": [
    "successfully transplanted lab-grown coral fragments onto damaged reef sections",
    "concerned about the long-term survival rate of transplanted corals",
  ],
  "note/question":
    "what are the most effective methods for monitoring and improving coral transplant survival rates?",
  "note/coral_species": [
    "Acropora cervicornis",
    "Pocillopora damicornis",
    "Porites lobata",
  ],
  "note/request":
    "compile recent research on coral transplantation techniques, focusing on methods to improve long-term survival rates and adaptation to changing ocean conditions",
};

await storeMemoryWithConnections(newDoc);

// Query to find connections
function getAllMemoriesWithConnections() {
  const query = `
    [:find ?e ?timestamp ?tag ?connFrom ?connTo ?connTag
     :where
     [?e "note/timestamp" ?timestamp]
     [?e "note/tag" ?tag]
     (or
       [?conn "connection/from" ?e]
       [?conn "connection/to" ?e])
     [?conn "connection/from" ?connFrom]
     [?conn "connection/to" ?connTo]
     [?conn "connection/tag" ?connTag]]
  `;
  return datascript.q(query, datascript.db(conn));
}

function getConnections() {
  const query = `
    [:find ?from ?to ?tag
     :where
     [?c "connection/from" ?from]
     [?c "connection/to" ?to]
     [?c "connection/tag" ?tag]]
  `;
  return datascript.q(query, datascript.db(conn));
}

// console.log("Connections:", getConnections());

// console.log("All Notes:");
// console.log(getAllNotes());

// console.log("\nAll Memories with Connections:");
// console.log(getAllMemoriesWithConnections());

console.log("All tags in the database:");
console.log(getAllTags());

console.log("\nAll notes with their tags:");
console.log(getAllNotesWithTags());

const newDocTags = ["bonsai"];
console.log("\nSearching for related memories with tags:", newDocTags);
const relatedMemories = findRelatedMemories(newDocTags);
console.log("Related memories:", relatedMemories);

// Now insert the new document
const newMemoryId = await storeMemoryWithConnections(newDoc);
console.log("\nNew memory stored with ID:", newMemoryId);

console.log("\nAll notes with their tags after insertion:");
console.log(getAllNotesWithTags());

console.log("\nSearching for related memories again with tags:", newDocTags);
const relatedMemoriesAfter = findRelatedMemories(newDocTags);
console.log("Related memories after insertion:", relatedMemoriesAfter);
