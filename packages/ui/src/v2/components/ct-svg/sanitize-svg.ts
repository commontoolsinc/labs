/**
 * Sanitizes SVG strings to prevent XSS attacks.
 *
 * Uses browser-native DOMParser to parse and walk the SVG DOM tree,
 * removing dangerous elements and attributes.
 *
 * @param svgString - The SVG string to sanitize
 * @returns Sanitized SVG string, or empty string if parsing fails
 */
export function sanitizeSvg(svgString: string): string {
  // Handle empty input
  if (!svgString || typeof svgString !== "string") {
    return "";
  }

  const trimmed = svgString.trim();
  if (trimmed === "") {
    return "";
  }

  // Parse the SVG string
  const parser = new DOMParser();
  const doc = parser.parseFromString(trimmed, "image/svg+xml");

  // Check for parser errors
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    return "";
  }

  // Dangerous elements to remove (case-insensitive)
  const DANGEROUS_ELEMENTS = new Set([
    "script",
    "foreignobject",
    "iframe",
    "embed",
    "object",
    "applet",
    "meta",
    "link",
    "set", // SVG <set> can target event handler attributes
  ]);

  // URL attributes that need sanitization
  const URL_ATTRIBUTES = new Set([
    "href",
    "xlink:href",
    "src",
    "action",
    "formaction",
  ]);

  // Dangerous URL protocols (case-insensitive)
  const DANGEROUS_PROTOCOLS = ["javascript:", "vbscript:", "data:text/html"];

  /**
   * Recursively walks the DOM tree and sanitizes nodes
   */
  function sanitizeNode(node: Node): void {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tagName = element.tagName.toLowerCase();

      // Remove dangerous elements
      if (DANGEROUS_ELEMENTS.has(tagName)) {
        element.remove();
        return;
      }

      // Remove event handler attributes (onclick, onload, onerror, etc.)
      const attributesToRemove: string[] = [];
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        const attrName = attr.name.toLowerCase();

        // Remove event handlers
        if (attrName.startsWith("on")) {
          attributesToRemove.push(attr.name);
          continue;
        }

        // Sanitize URL attributes
        if (URL_ATTRIBUTES.has(attrName)) {
          const attrValue = attr.value.trim().toLowerCase();
          for (const protocol of DANGEROUS_PROTOCOLS) {
            if (attrValue.startsWith(protocol)) {
              attributesToRemove.push(attr.name);
              break;
            }
          }
        }
      }

      // Remove dangerous attributes
      for (const attrName of attributesToRemove) {
        element.removeAttribute(attrName);
      }

      // Recursively sanitize children
      const children = Array.from(element.childNodes);
      for (const child of children) {
        sanitizeNode(child);
      }
    }
  }

  // Sanitize the document
  sanitizeNode(doc.documentElement);

  // Serialize back to string
  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}
