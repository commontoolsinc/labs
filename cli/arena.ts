export interface Channel {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  published: boolean;
  open: boolean;
  collaboration: boolean;
  slug: string;
  length: number;
  kind: "default" | "profile";
  status: "private" | "closed" | "public";
  user_id: number;
  contents?: (Block | Channel)[];
  collaborators?: User[];
}

export interface Block {
  position?: number;
  selected?: boolean;
  connected_at?: string;
  connected_by_user_id?: number;
}

export interface User {
  id: number;
  slug: string;
  first_name: string;
  last_name: string;
  full_name: string;
  avatar: string;
  channel_count: number;
  following_count: number;
  follower_count: number;
  profile_id: number;
}

// client.ts
export class ArenaClient {
  private baseUrl = "http://api.are.na/v2";
  private apiKey: string;

  constructor(config: { apiKey?: string } = {}) {
    this.apiKey = config.apiKey ?? Deno.env.get("ARENA_API_KEY") ?? "";
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Arena API Error: ${response.status} ${response.statusText}`,
      );
    }

    return response.json();
  }

  getChannel(slug: string): Promise<Channel> {
    return this.fetch<Channel>(`/channels/${slug}`);
  }

  getChannelContents(
    slug: string,
    params: { page?: number; per?: number } = {},
  ): Promise<Channel["contents"]> {
    const queryParams = new URLSearchParams();
    if (params.page) queryParams.set("page", params.page.toString());
    if (params.per) queryParams.set("per", params.per.toString());

    const query = queryParams.toString();
    return this.fetch<Channel["contents"]>(
      `/channels/${slug}/contents${query ? `?${query}` : ""}`,
    );
  }

  createChannel(
    params: { title: string; status?: Channel["status"] },
  ): Promise<Channel> {
    return this.fetch<Channel>("/channels", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  updateChannel(
    slug: string,
    params: {
      title?: string;
      status?: Channel["status"];
    },
  ): Promise<Channel> {
    return this.fetch<Channel>(`/channels/${slug}`, {
      method: "PUT",
      body: JSON.stringify(params),
    });
  }

  async addBlockToChannel(
    slug: string,
    params: { source: string } | { content: string },
  ): Promise<void> {
    await this.fetch(`/channels/${slug}/blocks`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  getCollaborators(slug: string): Promise<User[]> {
    return this.fetch<User[]>(`/channels/${slug}/collaborators`);
  }
}

// usage:
// env: ARENA_API_KEY
// const client = new ArenaClient();

// Get channel info
// const channel = await client.getChannel("arena-influences");

// Get paginated contents
// const contents = await client.getChannelContents("arena-influences", {
//   page: 1,
//   per: 25,
// });
