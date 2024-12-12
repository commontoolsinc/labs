import { Fact, Codec } from "npm:synopsys"
import { refer, fromString } from "npm:merkle-reference"
const SYNOPSYS_URL = "http://localhost:8080";

export const tags = inbox('tags')

export function inbox(name: string) {
  return refer({ inbox: name, v: 1 })
}

export async function upsert(...facts: Fact[]) {
  const body = JSON.stringify(facts.map((f) => ({ Upsert: f })));
  console.log("URL", SYNOPSYS_URL, body);
  const response = await fetch(SYNOPSYS_URL, {
    method: "PATCH",
    body,
  });
  if (!response.ok) {
    throw new Error(`Error asserting facts: ${response.statusText}`);
  }

  return await response.json();
}

export async function send(content: Uint8Array) {
  const response = await fetch(SYNOPSYS_URL, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/synopsys-sync",
      },
      body: content,
    });

  if (!response.ok) {
    throw new Error(response.statusText);
  }

  const result = await response.json();
  if (result.error) {
    throw new Error(result.error);
  }

  return result;
}


const doc = {
  url: 'http://google.com',
  content: 'test'
}
const id = refer(doc)

console.log(id.toString())

const instructions = [
  [id, 'url', doc.url],
  [id, 'content', doc.content],
  [tags, '#import', id],
  [id, '#import', tags],
]

const txn = instructions.map((f) => ({ Upsert: f }))
console.log('txn', txn)
const content = Codec.encodeTransaction(txn);
console.log('content', content)
const response = await send(content);
console.log('done', response)
