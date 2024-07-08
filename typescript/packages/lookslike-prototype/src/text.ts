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
