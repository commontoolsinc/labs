import { html } from "@commontools/common-html";
import {
  recipe,
  fetchData,
  UI,
  NAME,
  ifElse,
  lift,
  handler,
  str
} from "@commontools/common-builder";
import { launch } from "../data.js";

interface Channel {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  published: boolean;
  open: boolean;
  collaboration: boolean;
  slug: string;
  length: number;
  kind: string;
  status: string;
  user_id: number;
  class: string;
  base_class: string;
  user: {
    id: number;
    slug: string;
    first_name: string;
    last_name: string;
    full_name: string;
    avatar: string;
    email: string;
    channel_count: number;
    following_count: number;
    follower_count: number;
    profile_id: number;
  };
  total_pages: number;
  current_page: number;
  per: number;
  follower_count: number;
  contents: any[] | null;
  collaborators: any[] | null;
}

const API_BASE_URL = "http://api.are.na/v2";

// Move all handlers to the top
const onViewChannel = handler<{}, { slug: string }>(
  (_, { slug }) => {
    console.log("view channel", slug);
    launch(viewChannel, { slug });
  }
);

const onChangePage = handler<{}, { page: number; per: number }>(
  (_, { page, per }) => {
    console.log("change page", page);
    launch(fetchChannels, { page, per });
  }
);

const onAddBlock = handler<{}, { channelSlug: string }>(
  (_, { channelSlug }) => {
    const content = prompt("Enter block content:");
    if (content) {
      launch(addBlock, { channelSlug, content });
    }
  }
);

const tap = lift(x => {
  console.log(x);
  return x;
})

const getCollectionRows = lift((result: any) => (result?.channels || []).map(c => ({ title: c.title, id: c.id, slug: c.slug, status: c.status, length: c.length })));
const getItemRows = lift((result: any) => (result?.contents || []).map(c => ({ title: c.title, id: c.id, slug: c.slug, status: c.status, length: c.length })));

const buildUrl = lift(({ base, page, per }:{ base: string, page: number, per: number }) =>
  `${base}/channels?page=${page}&per=${per}`
);

const fetchChannels = recipe<{ page?: number; per?: number }>(
  "Fetch Channels",
  ({ page = 1, per = 25 }) => {
    const { result } = fetchData<{ channels: Channel[], total_pages: number, current_page: number }>({
      url: buildUrl({ base: API_BASE_URL, page, per }),
      schema: {
        type: "object",
        properties: {
          channels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                title: { type: "string" },
                slug: { type: "string" },
                status: { type: "string" },
                length: { type: "number" },
              },
            },
          },
          total_pages: { type: "number" },
          current_page: { type: "number" },
        },
      },
    });

    const rows = getCollectionRows(result);
    tap(rows);

    return {
      [NAME]: "Fetch Channels",
      [UI]: html`
        <div>
          ${ifElse(
            result,
            html`
                <div>
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>ID</th>
                    <th>Title</th>
                    <th>Slug</th>
                    <th>Status</th>
                    <th>Length</th>
                  </tr>
                </thead>
                <tbody>
                  ${getCollectionRows(result).map(
                    (channel) => html`
                      <tr>
                        <td>
                          <common-button onclick=${onViewChannel({ slug: channel.slug })}>
                            View Channel
                          </common-button>
                        </td>
                        <td>${channel.id}</td>
                        <td>${channel.title}</td>
                        <td>${channel.slug}</td>
                        <td>${channel.status}</td>
                        <td>${channel.length}</td>
                      </tr>
                    `
                  )}
                </tbody>
              </table>
                </div>
            `,
            html`<div>Loading...</div>`
          )}
        </div>
      `,
      result,
    };
  }
);
const buildChannelUrl = lift(({ base, slug }: { base: string, slug: string }) =>
  `${base}/channels/${slug}`
);

const getChannelContents = lift((result: Channel) => (result ? ({
  id: result.id,
  contents: result.contents?.map(content => ({
    id: content.id,
    title: content.title
  })),
}): result));

const viewChannel = recipe<{ slug: string }>(
  "View Channel",
  ({ slug }) => {
    const { result } = fetchData<Channel>({
      url: buildChannelUrl({ base: API_BASE_URL, slug }),
      schema: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          slug: { type: "string" },
          status: { type: "string" },
          length: { type: "number" },
          contents: { type: "array" },
        },
      },
    });

    tap(result);
    const data = getChannelContents(result)

    return {
      [NAME]: str`Channel: ${result?.title || "(unknown)"}`,
      [UI]: html`
        <div>
          ${ifElse(
            result,
            html`
                <div>
              <h2>${result.title}</h2>
              <p>Status: ${result.status}</p>
              <p>Length: ${result.length}</p>
              <h3>Contents:</h3>
              <ul>
                ${data.contents.map(
                  (item: any) => html`
                    <li>${item.title}</li>
                  `
                )}
              </ul>
              <common-button onclick=${onAddBlock({ channelSlug: result.slug })}>
                Add Block
              </common-button>
                </div>
            `,
            html`<div>Loading...</div>`
          )}
        </div>
      `,
      result,
    };
  }
);

const createChannel = recipe<{ title: string; status?: string }>(
  "Create Channel",
  ({ title, status = "public" }) => {
    const { result } = fetchData<Channel>({
      url: `${API_BASE_URL}/channels`,
      method: "POST",
      body: JSON.stringify({ title, status }),
      headers: { "Content-Type": "application/json" },
      schema: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          slug: { type: "string" },
          status: { type: "string" },
        },
      },
    });

    return {
      [NAME]: "Create Channel",
      [UI]: html`
        <div>
          ${ifElse(
            result,
            html`
                <div>
              <h2>Channel Created Successfully</h2>
              <p>Title: ${result.title}</p>
              <p>Slug: ${result.slug}</p>
              <p>Status: ${result.status}</p>
              <common-button onclick=${onViewChannel({ slug: result.slug })}>
                View Channel
              </common-button>
                </div>
            `,
            html`<div>Creating channel...</div>`
          )}
        </div>
      `,
      result,
    };
  }
);

const addBlock = recipe<{ channelSlug: string; content: string }>(
  "Add Block",
  ({ channelSlug, content }) => {
    const { result } = fetchData<any>({
      url: `${API_BASE_URL}/channels/${channelSlug}/blocks`,
      method: "POST",
      body: JSON.stringify({ content }),
      headers: { "Content-Type": "application/json" },
      schema: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          content: { type: "string" },
        },
      },
    });

    return {
      [NAME]: "Add Block",
      [UI]: html`
        <div>
          ${ifElse(
            result,
            html`
                <div>
              <h2>Block Added Successfully</h2>
              <p>Content: ${result.content}</p>
              <common-button onclick=${onViewChannel({ slug: channelSlug })}>
                Back to Channel
              </common-button>
                </div>
            `,
            html`<div>Adding block...</div>`
          )}
        </div>
      `,
      result,
    };
  }
);

export const arenaRecipes = {
  fetchChannels,
  viewChannel,
  createChannel,
  addBlock,
};
