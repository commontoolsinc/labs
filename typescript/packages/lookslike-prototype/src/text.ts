export function truncatedJSON(input: any, maxLength: number = 255): string {
  try {
    // Convert input to JSON
    const jsonString = JSON.stringify(input);

    // Truncate the JSON string if it exceeds maxLength
    if (jsonString.length <= maxLength) {
      return jsonString;
    } else {
      // Truncate and add ellipsis
      return jsonString.slice(0, maxLength - 3) + "...";
    }
  } catch (error) {
    // Handle any JSON stringification errors
    return `Error: Unable to convert to JSON - ${(error as Error).message}`;
  }
}

export function truncate(input: string, maxLength: number = 255): string {
  // Truncate the JSON string if it exceeds maxLength
  if (input.length <= maxLength) {
    return input;
  } else {
    // Truncate and add ellipsis
    return input.slice(0, maxLength - 3) + "...";
  }
}

export function formatDataForPreview(obj: any): string {
  if (typeof obj == "object") {
    return truncate(JSON.stringify(obj, null, 2));
  } else if (Array.isArray(obj)) {
    return `[${truncate(obj.map(formatDataForPreview).join(", "))}]`;
  } else {
    return `${obj}`;
  }
}

export function formatDataForConsole(obj: any): string {
  if (typeof obj == "object") {
    return JSON.stringify(obj, null, 2);
  } else if (Array.isArray(obj)) {
    return `[${obj.map(formatDataForPreview).join(", ")}]`;
  } else {
    return `${obj}`;
  }
}
