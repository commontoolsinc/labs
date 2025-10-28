// LLM Generated
// Simple DOM Parser interface for browser/deno execution.
// In lieu of 3P module support, and the alternate solution requiring all
// 3P modules to be checked into the workspace, this seems like the most simple solution.

interface Node {
  nodeType: number;
  nodeName: string;
  parentNode: Node | null;
  childNodes: Node[];
  textContent: string | null;
}

interface Element extends Node {
  tagName: string;
  attributes: Map<string, string>;
  children: Element[];

  // Query methods
  getElementsByTagName(tagName: string): Element[];
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): Element[];

  // Attribute methods
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;

  // Content methods
  appendChild(child: Element): Element;
  removeChild(child: Element): Element;

  // Properties
  innerHTML: string;
  outerHTML: string;
  id: string;
  className: string;
}

interface Document extends Node {
  documentElement: Element | null;

  // Query methods
  getElementsByTagName(tagName: string): Element[];
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): Element[];
  getElementById(id: string): Element | null;

  // Creation methods
  createElement(tagName: string): Element;
}

class MinimalElement implements Element {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  parentNode: Node | null = null;
  childNodes: Node[] = [];
  children: Element[] = [];
  attributes: Map<string, string> = new Map();
  textContent: string | null = null;
  innerHTML = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  // Attribute methods
  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) || null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name.toLowerCase(), value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }

  // Query methods
  getElementsByTagName(tagName: string): Element[] {
    const results: Element[] = [];
    const tag = tagName.toUpperCase();

    if (tag === "*" || this.tagName === tag) {
      results.push(this);
    }

    for (const child of this.children) {
      results.push(...child.getElementsByTagName(tagName));
    }

    return results;
  }

  querySelector(selector: string): Element | null {
    const results = this.querySelectorAll(selector);
    return results[0] || null;
  }

  querySelectorAll(selector: string): Element[] {
    // Very basic selector support: tagName, #id, .class, [attr]
    const results: Element[] = [];

    // Tag selector
    if (/^[a-z]+$/i.test(selector)) {
      return this.getElementsByTagName(selector);
    }

    // ID selector
    if (selector.startsWith("#")) {
      const id = selector.slice(1);
      this.traverse((el) => {
        if (el.id === id) results.push(el);
      });
      return results;
    }

    // Class selector
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      this.traverse((el) => {
        if (el.className.split(/\s+/).includes(className)) {
          results.push(el);
        }
      });
      return results;
    }

    // Attribute selector [attr] or [attr=value]
    const attrMatch = selector.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/);
    if (attrMatch) {
      const [, attrName, attrValue] = attrMatch;
      this.traverse((el) => {
        if (attrValue !== undefined) {
          if (el.getAttribute(attrName) === attrValue) {
            results.push(el);
          }
        } else {
          if (el.hasAttribute(attrName)) {
            results.push(el);
          }
        }
      });
      return results;
    }

    return results;
  }

  private traverse(callback: (el: Element) => void): void {
    callback(this);
    for (const child of this.children) {
      (child as MinimalElement).traverse(callback);
    }
  }

  // DOM manipulation
  appendChild(child: Element): Element {
    child.parentNode = this;
    this.children.push(child);
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: Element): Element {
    const index = this.children.indexOf(child);
    if (index > -1) {
      this.children.splice(index, 1);
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  // Properties
  get id(): string {
    return this.getAttribute("id") || "";
  }

  set id(value: string) {
    this.setAttribute("id", value);
  }

  get className(): string {
    return this.getAttribute("class") || "";
  }

  set className(value: string) {
    this.setAttribute("class", value);
  }

  get outerHTML(): string {
    const attrs = Array.from(this.attributes.entries())
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");

    if (this.children.length === 0 && !this.innerHTML) {
      return `<${this.tagName.toLowerCase()}${attrs} />`;
    }

    return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  set outerHTML(value: string) {
    this.innerHTML = value;
  }
}

class MinimalDocument implements Document {
  nodeType = 9;
  nodeName = "#document";
  parentNode: Node | null = null;
  childNodes: Node[] = [];
  textContent: string | null = null;
  documentElement: Element | null = null;

  createElement(tagName: string): Element {
    return new MinimalElement(tagName);
  }

  getElementsByTagName(tagName: string): Element[] {
    if (!this.documentElement) return [];
    return this.documentElement.getElementsByTagName(tagName);
  }

  querySelector(selector: string): Element | null {
    if (!this.documentElement) return null;
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): Element[] {
    if (!this.documentElement) return [];
    return this.documentElement.querySelectorAll(selector);
  }

  getElementById(id: string): Element | null {
    return this.querySelector(`#${id}`);
  }
}

class DOMParser {
  parseFromString(source: string, mimeType: DOMParserSupportedType): Document {
    if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
      return this.parseHTML(source);
    } else if (mimeType === "text/xml" || mimeType === "application/xml") {
      return this.parseXML(source);
    }

    throw new Error(`Unsupported MIME type: ${mimeType}`);
  }

  private parseHTML(source: string): Document {
    const doc = new MinimalDocument();
    const html = doc.createElement("html");
    doc.documentElement = html;

    // Very basic parsing - extract body
    const bodyMatch = source.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      const body = this.parseElement(source, "body", doc);
      if (body) html.appendChild(body);
    }

    return doc;
  }

  private parseXML(source: string): Document {
    const doc = new MinimalDocument();

    // Remove XML declaration and other processing instructions
    let cleanSource = source.replace(/<\?xml[^?]*\?>/gi, "");
    cleanSource = cleanSource.replace(/<\?[^?]*\?>/g, "");
    cleanSource = cleanSource.trim();

    // Find the root element (first opening tag)
    const rootMatch = cleanSource.match(/<([^>\s/]+)/);

    if (rootMatch) {
      const tagName = rootMatch[1];
      const root = this.parseElement(cleanSource, tagName, doc);
      if (root) doc.documentElement = root;
    }

    return doc;
  }

  private parseElement(
    source: string,
    tagName: string,
    doc: Document,
  ): Element | null {
    const element = doc.createElement(tagName);

    // Parse attributes
    const tagPattern = new RegExp(`<${tagName}([^>]*)>`, "i");
    const tagMatch = source.match(tagPattern);

    if (tagMatch && tagMatch[1]) {
      const attrPattern = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrPattern.exec(tagMatch[1])) !== null) {
        element.setAttribute(attrMatch[1], attrMatch[2]);
      }
    }

    // Parse innerHTML (simplified)
    const contentPattern = new RegExp(
      `<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`,
      "i",
    );
    const contentMatch = source.match(contentPattern);
    if (!contentMatch || !contentMatch[1]) {
      return element;
    }

    const content = contentMatch[1];

    // Parse child elements recursively
    const childTagPattern = /<([^>\s/]+)(?:\s[^>]*)?\/?>/g;
    let match;
    let lastIndex = 0;

    while ((match = childTagPattern.exec(content)) !== null) {
      const childTagName = match[1];
      const childStartIndex = match.index;

      // Add any text content before this child element
      if (childStartIndex > lastIndex) {
        const textContent = content.substring(lastIndex, childStartIndex)
          .trim();
        if (textContent) {
          // Store as innerHTML for text nodes (simplified)
          element.innerHTML += textContent;
          element.textContent = textContent;
        }
      }

      // Find the full child element (from opening to closing tag or self-closing)
      let childSource;
      if (match[0].endsWith("/>")) {
        // Self-closing tag
        childSource = match[0];
        lastIndex = childStartIndex + match[0].length;
      } else {
        // Find matching closing tag
        const childContentPattern = new RegExp(
          `<${childTagName}[^>]*>([\\s\\S]*?)</${childTagName}>`,
          "i",
        );
        const childContentMatch = content.substring(childStartIndex).match(
          childContentPattern,
        );

        if (childContentMatch) {
          childSource = childContentMatch[0];
          lastIndex = childStartIndex + childSource.length;
        } else {
          lastIndex = childStartIndex + match[0].length;
          continue;
        }
      }

      // Recursively parse the child element
      const childElement = this.parseElement(childSource, childTagName, doc);
      if (childElement) {
        element.appendChild(childElement);
      }
    }

    // Add any remaining text content after the last child
    if (lastIndex < content.length) {
      const textContent = content.substring(lastIndex).trim();
      if (textContent) {
        element.innerHTML += textContent;
        element.textContent = textContent;
      }
    }

    return element;
  }
}

type DOMParserSupportedType =
  | "text/html"
  | "text/xml"
  | "application/xml"
  | "application/xhtml+xml"
  | "image/svg+xml";

export { DOMParser };
export type { Document, Element, Node };
