export function extractJSON(
  text: string,
): Record<string, unknown> | Array<Record<string, unknown>> {
  try {
    // Try to extract from markdown code block first
    const markdownMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
      return JSON.parse(markdownMatch[1].trim());
    }

    // If not in markdown, try to find JSON-like content
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0].trim());
    }

    // If no special formatting, try parsing the original text
    return JSON.parse(text.trim());
  } catch (error) {
    return {};
  }
}
