import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  schema,
  UI,
} from "@commontools/builder";
import {
  AppBskyEmbedExternal,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
  AppBskyEmbedVideo,
  AppBskyFeedDefs,
  AppBskyFeedPost,
  AtpAgent,
} from "@atproto/api";

const BlueskyCredentialsSchema = {
  type: "object",
  properties: {
    identifier: {
      type: "string",
      default: "",
    },
    password: {
      type: "string",
      default: "",
    },
  },
  required: ["identifier", "password"],
  description: "Bluesky user credentials",
} as const satisfies JSONSchema;
type BlueskyCredentials = Schema<typeof BlueskyCredentialsSchema>;

const ReadyBlueskySessionSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ready"],
    },
    agent: {
      type: "string",
      description: "UUID corresponding to an active session",
    },
  },
  required: ["status", "agent"],
  description: "Bluesky authorization session",
} as const satisfies JSONSchema;
type ReadyBlueskySession = Schema<typeof ReadyBlueskySessionSchema>;

const FailedBlueskySessionSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["error"],
    },
    reason: {
      type: "object",
      properties: {
        headers: {
          type: "object",
        },
        data: {
          type: "object",
        },
      },
    },
  },
  required: ["status", "reason"],
  description: "Failed authorization session",
} as const satisfies JSONSchema;
type FailedBlueskySession = Schema<typeof FailedBlueskySessionSchema>;

const NoBlueskySessionSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["idle"],
    },
  },
  required: ["status"],
  description: "Not yet authorized session",
} as const satisfies JSONSchema;
type NoBlueskySession = Schema<typeof NoBlueskySessionSchema>;

const BlueskySessionSchema = {
  anyOf: [
    ReadyBlueskySessionSchema,
    FailedBlueskySessionSchema,
    NoBlueskySessionSchema,
  ],
} as const satisfies JSONSchema;
type BlueskySession = Schema<typeof BlueskySessionSchema>;

const BlueskyInputSchema = {
  type: "object",
  properties: {
    credentials: BlueskyCredentialsSchema,
    session: BlueskySessionSchema,
    cursor: {
      type: "string",
      default: "",
      description: "Cursor in the user timeline",
    },
  },
  required: ["session", "credentials", "cursor"],
} as const satisfies JSONSchema;
type BlueskyInput = Schema<typeof BlueskyInputSchema>;

const BlueskyAuthorSchema = {
  type: "object",
  properties: {
    did: {
      type: "string",
    },
    avatar: {
      type: "string",
    },
    displayName: {
      type: "string",
    },
    handle: {
      type: "string",
    },
  },
  required: ["did", "handle"],
} as const satisfies JSONSchema;

const BlueskyPostSchema = {
  type: "object",
  properties: {
    uri: {
      type: "string",
    },
    cid: {
      type: "string",
    },
    author: BlueskyAuthorSchema,
    embed: {
      type: "object",
    },
  },
  required: ["uri", "cid", "author"],
} as const satisfies JSONSchema;
type BlueskyPost = Schema<typeof BlueskyPostSchema>;

const ResultSchema = {
  type: "object",
  properties: {
    feed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          post: BlueskyPostSchema,
        },
      },
    },
  },
  required: ["feed"],
} as const satisfies JSONSchema;
type Result = Schema<typeof ResultSchema>;

// 🫠 Don't know how to hold references to the non JSON data objects so I'm working
// around that via global map. I feel bad, but I hope someone will teach me what
// is the proper way to deal with this.
class LocalReference extends Map<string, object> {
  static global: Map<string, object> =
    (globalThis as { LocalReference?: Map<string, object> }).LocalReference ??
      ((globalThis as { LocalReference?: Map<string, object> }).LocalReference =
        new Map());

  static for(source: object) {
    const id = crypto.randomUUID();
    this.global.set(id, source);
    return id;
  }
  static resolve(id: string) {
    return this.global.get(id);
  }
  static delete(id: string) {
    return this.global.delete(id);
  }
}

const updateIdentifier = handler<
  { detail: { value: string } },
  { identifier: string }
>(
  ({ detail }, state) => {
    state.identifier = detail?.value ?? "";
  },
);

const updatePassword = handler<
  { detail: { value: string } },
  { password: string }
>(
  ({ detail }, state) => {
    state.password = detail?.value ?? "";
  },
);

const authorize = handler<
  {},
  { credentials: BlueskyCredentials; session: BlueskySession }
>(async (_, state) => {
  if (
    state.credentials.identifier !== "" && state.credentials.password !== ""
  ) {
    const agent = new AtpAgent({ service: "https://bsky.social" });
    const response = await agent.login({
      identifier: state.credentials.identifier,
      password: state.credentials.password,
    });

    if (!response.success) {
      state.session = { status: "error", reason: {} }; // FIXME: response };
      console.log("Failed to log in");
    } else {
      state.session = { status: "ready", agent: LocalReference.for(agent) };
      console.log("Agent: ", state.session.agent);
    }
    console.log("Session: ", state.session);
  }
});

const DownloadEventSchema = {
  type: "object",
} as const satisfies JSONSchema;

const DownloadStateSchema = {
  type: "object",
  properties: {
    session: ReadyBlueskySessionSchema,
    cursor: { type: "string" },
    feed: {
      type: "array",
      items: BlueskyPostSchema,
      default: [],
      asCell: true,
    },
  },
  required: ["session", "cursor", "feed"],
} as const satisfies JSONSchema;
const download = handler(
  DownloadEventSchema,
  DownloadStateSchema,
  async (_event, state) => {
    const agent = LocalReference.resolve(state.session.agent) as AtpAgent;
    const { data } = await agent.getTimeline({
      cursor: state.cursor,
      limit: 10,
    });

    // Ok this is not ideal, but without this we run into various proxy problems
    const { feed: updated_feed, cursor } = JSON.parse(JSON.stringify(data));

    for (const item of updated_feed) {
      state.feed.push(item);
    }

    // if (cursor) {
    //   state.cursor = cursor;
    // } // When you read last page it appears that client does not give you a cursor
    // so we read it from the last post.record.createAt which it seems to
    // correspond to.
    // else if (state.feed.length > 0) {
    //   state.cursor = feed.at(-1).post.record.createdAt;
    // }
  },
);
// const view = (state: BlueskyInput, output: Result) => {
//   derive(
//     state.session.status,
//     (status) =>
//       console.log("view session status undefined: ", status === undefined),
//   );
//   viewA(state, output);
// };

const view = (state: BlueskyInput, output: Result) =>
  ifElse(
    derive(state.session.status, (status) =>
      status === undefined || status === "idle"),
    viewIdle(state),
    viewReadyOrFailed(state, output),
  );

const viewReadyOrFailed = (state: BlueskyInput, output: Result) =>
  ifElse(
    derive(state.session.status, (status) => status === "ready"),
    viewReady(
      state as { session: ReadyBlueskySession; cursor: string },
      output,
    ),
    viewFailed(state as { session: FailedBlueskySession }),
  );

const viewIdle = ({ credentials, session }: BlueskyInput) => (
  <div>
    Login
    <common-input
      value={credentials.identifier}
      placeholder="Username"
      oncommon-input={updateIdentifier({
        identifier: credentials.identifier,
      })}
    />
    <common-input
      value={credentials.password}
      placeholder="Password"
      password
      oncommon-input={updatePassword({ password: credentials.password })}
    />
    <sl-button
      outline
      variant="danger"
      onclick={authorize({ credentials, session })}
    >
      Next
    </sl-button>
  </div>
);

const viewReady = (
  { session, cursor }: {
    session: ReadyBlueskySession;
    cursor: string;
  },
  output: Result,
) => (
  <div>
    <p>
      Import from start
    </p>
    <div>
      <sl-button
        outline
        onclick={download({ session, cursor, feed: output.feed })}
      >
        Import
      </sl-button>
    </div>
    <div data-role="posts">{output.feed.map(viewPost)}</div>
  </div>
);

const viewPost = ({ post }: { post: BlueskyPost }) => (
  <div data-uri={post.uri} data-cid={post.cid}>
    {viewAuthor(post.author)}
    <div>{post.record?.text}</div>
    {viewEmbed(post.embed ?? {})}
  </div>
);

const viewAuthor = (author: AppBskyFeedDefs.PostView["author"]) => (
  <div>
    <p title={author.did}>
      <img
        src={author.avatar}
        style="width: 42px; height: 42px; border-radius: 21px;"
      />
      <span>{author.displayName ?? ""}</span>
      <code>{author.handle}</code>
    </p>
  </div>
);

const viewPostContent = (post: AppBskyFeedPost.Record) =>
  ifElse(
    derive(post, AppBskyFeedPost.isRecord),
    viewRecordWithText(post as AppBskyFeedPost.Record),
    viewEmbed(post.embed as AppBskyFeedDefs.PostView["embed"]),
  );

const viewEmbed = (embed: AppBskyFeedDefs.PostView["embed"]) =>
  ifElse(
    derive(embed, AppBskyEmbedExternal.isView),
    viewExternalEmbed(embed as AppBskyEmbedExternal.View),
    viewMaybeImageEmbed(embed),
  );

const viewMaybeImageEmbed = (embed: AppBskyFeedDefs.PostView["embed"]) =>
  ifElse(
    derive(embed, AppBskyEmbedImages.isView),
    viewImagesEmbed(embed as AppBskyEmbedImages.View),
    viewMaybeVideoEmbed(embed),
  );

const viewMaybeVideoEmbed = (embed: AppBskyFeedDefs.PostView["embed"]) =>
  ifElse(
    derive(embed, AppBskyEmbedVideo.isView),
    viewViedoEmbed(embed as AppBskyEmbedVideo.View),
    viewMaybeRecordEmbed(embed),
  );

const viewMaybeRecordEmbed = (embed: AppBskyFeedDefs.PostView["embed"]) =>
  ifElse(
    derive(embed, AppBskyEmbedRecord.isView),
    viewRecordEmbed(embed as AppBskyEmbedRecord.View),
    viewMaybeRecordWithMedia(embed),
  );

const viewMaybeRecordWithMedia = (embed: AppBskyFeedDefs.PostView["embed"]) =>
  ifElse(
    derive(embed, AppBskyEmbedRecordWithMedia.isView),
    viewRecordWithMedia(embed as AppBskyEmbedRecordWithMedia.View),
    viewUnknownEmbed(embed as { $type: string; [k: string]: unknown }),
  );

const viewExternalEmbed = ({ external }: AppBskyEmbedExternal.View) => (
  <div>
    <a href={external.uri}>{external.title}</a>
    <p>{external.description}</p>
    <img src={external.thumb} style="width: 50%;" />
  </div>
);
const viewImagesEmbed = (embed: AppBskyEmbedImages.View) => <div>{embed}</div>;
const viewViedoEmbed = (embed: AppBskyEmbedVideo.View) => (
  <div data-cid={embed.cid}>
    <video
      width={embed.aspectRatio?.width}
      height={embed.aspectRatio?.height}
      src={embed.playlist}
    >
      <img src={embed.thumbnail} alt={embed.alt} />
    </video>
  </div>
);
const viewRecordEmbed = (embed: AppBskyEmbedRecord.View) => <div>{embed}</div>;
const viewRecordWithMedia = (embed: AppBskyEmbedRecordWithMedia.View) => (
  <div>{embed}</div>
);
const viewUnknownEmbed = (embed: { $type: string; [k: string]: unknown }) => (
  <div>
    <pre>{derive(embed, (embed) => JSON.stringify(embed))}</pre>
  </div>
);
const viewRecordWithText = (post: AppBskyFeedPost.Record) => (
  <div>Text: {post.text}</div>
);
const viewFailed = (
  { session }: { session: FailedBlueskySession },
) => (
  <os-container>
    Error
    <pre>{derive(session, (session) => JSON.stringify(session))}</pre>
  </os-container>
);

async function getRecent(state: BlueskyInput) {
  if (state.session.status !== "ready") return null;
  const agent = LocalReference.resolve(state.session.agent) as AtpAgent;
  const { data } = await agent.getTimeline({
    limit: 30,
  });
  return data;
}

const viewHelper = handler(
  {
    type: "object",
    properties: {
      detail: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  },
  {
    type: "object",
    properties: { limit: { type: "number", asCell: true } },
    required: ["limit"],
  },
  ({ detail }, state) => {
    state.limit.set(parseInt(detail?.value ?? "10") || 0);
  },
);

// const view = (state: BlueskyInput, output: Result) => viewIdle(state);

export default recipe(
  BlueskyInputSchema,
  ResultSchema,
  ({ credentials, session, cursor }) => {
    const feed = cell<BlueskyPost[]>([]);

    derive(feed, (feed) => {
      console.log("feed entries", feed);
    });

    const state: BlueskyInput = {
      credentials: credentials,
      session: session,
      cursor: cursor,
    };
    return {
      [NAME]: "Bluesky Importer",
      [UI]: <div>{view(state, feed)}</div>,
      feed, // this sets state.messages, we inspect in handler()
    } as Result;
  },
);

const updaterSchema = {
  type: "object",
  properties: {
    newValues: { type: "array", items: { type: "string" } },
  },
  title: "Update Values",
  description: "Append `newValues` to the list.",
  example: { newValues: ["foo", "bar"] },
  default: { newValues: [] },
} as const satisfies JSONSchema;

// Different way to define the same schema, using 'schema' helper function,
// let's as leave off `as const as JSONSchema`.
const inputSchema = schema({
  type: "object",
  properties: {
    values: { type: "array", items: { type: "string" }, asCell: true },
  },
  default: { values: [] },
});
