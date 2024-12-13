import { Codec, Instruction } from "synopsys";
import { refer } from "merkle-reference";
import { FormattedClip } from "./model.js";

const SYNOPSYS_URL = process.env.SYNOPSYS_URL || "http://localhost:8080";

// Inbox references
export const tags = inbox('tags');
export const clips = inbox('clips');

export function inbox(name: string) {
  return refer({ inbox: name, v: 1 });
}

async function send(content: Uint8Array) {
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

export async function saveClip(formattedClip: FormattedClip) {
  // Remove null/undefined values recursively
  const cleanObject = (obj: any): any => {
    if (Array.isArray(obj)) {
      return obj.map(item => cleanObject(item)).filter(item => item != null);
    }

    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj)
          .map(([key, value]) => [key, cleanObject(value)])
          .filter(([_, value]) => value != null)
      );
    }

    return obj;
  };

  const cleanedClip = cleanObject(formattedClip);

  // Create a reference for the clip
  const clipId = refer(cleanedClip);

  // Create transaction instructions
  const txn: Instruction[] = [
    // Import the full clip data
    { Import: cleanedClip as any },
    // Link to tags inbox
    { Assert: [tags, '#import', clipId] },
    { Assert: [clipId, '#import', tags] },
    // Link to clips inbox
    { Assert: [clips, '#import', clipId] },
    { Assert: [clipId, '#import', clips] }
  ];

  // Encode and send transaction
  const content = Codec.encodeTransaction(txn);

  try {
    const response = await send(content);
    return { success: true, clipId: clipId.toString(), response };
  } catch (error) {
    console.error('Failed to save clip:', error);
    throw error;
  }
}
