interface ReadwiseHighlight {
  id: number;
  text: string;
  note?: string;
  location?: number;
  location_type?: string;
  highlighted_at?: string;
  url?: string;
  color?: string;
  updated: string;
  book_id: number;
  tags: Array<{
    id: number;
    name: string;
  }>;
}

interface ReadwiseBook {
  id: number;
  title: string;
  author: string;
  category: string;
  source: string;
  num_highlights: number;
  last_highlight_at: string;
  updated: string;
  cover_image_url: string;
  highlights_url: string;
  source_url: string | null;
  asin: string | null;
}

interface HighlightResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: ReadwiseHighlight[];
}

export class ReadwiseClient {
  private token: string;
  private baseUrl = "https://readwise.io/api/v2";

  constructor(token: string) {
    this.token = token;
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Token ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Readwise API error: ${response.status} ${response.statusText}`,
      );
    }

    return response.json();
  }

  async getRandomHighlights(count = 5): Promise<ReadwiseHighlight[]> {
    try {
      // First, get total count of highlights
      const initial: HighlightResponse = await this.fetch(
        "/highlights/?page_size=1",
      );
      const totalHighlights = initial.count;

      // Generate random offset
      const randomOffset = Math.floor(
        Math.random() * Math.max(0, totalHighlights - count),
      );

      // Fetch highlights with random offset
      const response: HighlightResponse = await this.fetch(
        `/highlights/?page_size=${count}&offset=${randomOffset}`,
      );

      return response.results;
    } catch (error) {
      console.error("Failed to fetch random highlights:", error);
      throw error;
    }
  }

  async getHighlightsByBook(bookId: number): Promise<ReadwiseHighlight[]> {
    const response: HighlightResponse = await this.fetch(
      `/highlights/?book_id=${bookId}`,
    );
    return response.results;
  }

  async getRecentHighlights(days = 7): Promise<ReadwiseHighlight[]> {
    const date = new Date();
    date.setDate(date.getDate() - days);
    const isoDate = date.toISOString();

    const response: HighlightResponse = await this.fetch(
      `/highlights/?highlighted_at__gt=${isoDate}`,
    );
    return response.results;
  }
}

// usage:
// const client = new ReadwiseClient(Deno.env.get("READWISE_TOKEN") || "");
// // Fetch some random highlights
// const highlights = await client.getRandomHighlights(5);
// console.log(highlights);
