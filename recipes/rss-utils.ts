import { DOMParser, type Element } from "./dom-parser.ts";

export type FeedItem = {
  id: string;
  title: string;
  link: string;
  description: string;
  pubDate: string;
  author: string;
  content: string;
};

export function parseRSSFeed(
  textXML: string,
  maxResults: number = 100,
  existingIds: Set<string>,
): FeedItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(textXML, "text/xml");
  // Helper function to get text content from an element
  const getTextContent = (element: Element | null, tagName: string) => {
    const el = element?.getElementsByTagName(tagName)[0];
    return el?.textContent?.trim() || "";
  };

  // Helper function to get attribute value
  const getAttributeValue = (
    element: Element | null,
    tagName: string,
    attrName: string,
  ) => {
    const el = element?.getElementsByTagName(tagName)[0];
    return el?.getAttribute(attrName) || "";
  };

  const retrievedItems: FeedItem[] = [];

  // Check if it's an Atom feed
  const isAtom = doc.getElementsByTagName("feed").length !== 0;

  if (isAtom) {
    // Parse Atom feed
    const entries = doc.getElementsByTagName("entry");

    for (let i = 0; i < Math.min(entries.length, maxResults); i++) {
      const entry = entries[i];

      // In Atom, id is mandatory
      const id = getTextContent(entry, "id") || Math.random().toString(36);

      // Skip if we already have this item
      if (existingIds.has(id)) {
        continue;
      }

      // Parse link - in Atom links are elements with href attributes
      const link = getAttributeValue(entry, "link", "href");

      // For content, check content tag first, then summary
      const content = getTextContent(entry, "content") ||
        getTextContent(entry, "summary");

      // For author, it might be nested as <author><name>Author</name></author>
      let author = "";
      const authorEl = entry.getElementsByTagName("author")[0];
      if (authorEl) {
        author = getTextContent(authorEl, "name");
      }

      // For pubDate, Atom uses <published> or <updated>
      const pubDate = getTextContent(entry, "published") ||
        getTextContent(entry, "updated");

      retrievedItems.push({
        id,
        title: getTextContent(entry, "title"),
        link,
        description: getTextContent(entry, "summary"),
        pubDate,
        author,
        content,
      });
    }
  } else {
    // Parse RSS feed
    const rssItems = doc.getElementsByTagName("item");

    for (let i = 0; i < Math.min(rssItems.length, maxResults); i++) {
      const item = rssItems[i];

      const id = getTextContent(item, "guid") ||
        getTextContent(item, "link") ||
        Math.random().toString(36);

      if (existingIds.has(id)) {
        continue;
      }

      retrievedItems.push({
        id,
        title: getTextContent(item, "title"),
        link: getTextContent(item, "link"),
        description: getTextContent(item, "description"),
        pubDate: getTextContent(item, "pubDate"),
        author: getTextContent(item, "author"),
        content: getTextContent(item, "content:encoded") ||
          getTextContent(item, "description"),
      });
    }
  }

  return retrievedItems;
}
