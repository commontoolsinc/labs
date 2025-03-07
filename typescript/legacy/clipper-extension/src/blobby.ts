import { FormattedClip } from "./model.js";

const TOOLSHED_URL = process.env.TOOLSHED_URL || "http://localhost:8000";

function generateKey(title: string): string {
  // Create a datetime string in format YYYYMMDD-HHMMSS
  const now = new Date();
  const datetime = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/[T.]/g, "-")
    .slice(0, 15);

  // Convert title to kebab case and clean it
  const kebabTitle = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // Remove special characters
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Replace multiple hyphens with single hyphen
    .substring(0, 50); // Limit length

  return `${kebabTitle}-${datetime}`;
}

async function send(key: string, data: any) {
  const response = await fetch(`${TOOLSHED_URL}/api/storage/blobby/${key}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
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

    if (obj && typeof obj === "object") {
      return Object.fromEntries(
        Object.entries(obj)
          .map(([key, value]) => [key, cleanObject(value)])
          .filter(([_, value]) => value != null),
      );
    }

    return obj;
  };

  const cleanedClip = cleanObject(formattedClip);

  // Generate key from title and datetime
  const key = generateKey(formattedClip.title || "untitled");

  try {
    const response = await send(key, cleanedClip);
    return {
      success: true,
      key,
      response,
    };
  } catch (error) {
    console.error("Failed to save clip:", error);
    throw error;
  }
}
