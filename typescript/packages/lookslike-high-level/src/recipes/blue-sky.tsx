import { h } from "@commontools/html";
import {
  recipe,
  handler,
  UI,
  NAME,
  ifElse,
  derive,
  cell,
  type OpaqueRef,
} from "@commontools/builder";
import { z, type TypeOf } from "zod";
import {
  AtpAgent,
  AppBskyFeedDefs,
  AppBskyEmbedExternal,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
  AppBskyEmbedVideo,
  AppBskyEmbedImages,
  AppBskyRichtextFacet,
} from "@atproto/api";

const Credentials = z
  .object({
    identifier: z.string().default(""),
    password: z.string().default(""),
  })
  .describe("Bluesky user credentials");

const ReadySession = z
  .object({
    status: z.literal("ready"),
    agent: z.string().describe("UUID corresponding to an active session"),
  })
  .describe("Bluesky authorization session");

const FailedSession = z
  .object({
    status: z.literal("error"),
    reason: z.object({
      headers: z.record(z.string(), z.string().optional()),
      data: z.record(z.string(), z.unknown()),
    }),
  })
  .describe("Failed authorization session");

const NoSession = z
  .object({
    status: z.literal("idle"),
  })
  .describe("Not yet authorized session");

const Session = NoSession.or(FailedSession).or(ReadySession);

const Model = z.object({
  credentials: Credentials,
  session: Session.default({ status: "idle" }),
  cursor: z.string().default("").describe("Cursor in the user timeline"),
});

const Output = z.object({
  feed: z.any().array(),
});

// 🫠 Don't know how to hold references to the non JSON data objects so I'm working
// around that via global map. I feel bad, but I hope someone will teach me what
// is the proper way to deal with this.
class LocalReference extends Map<string, object> {
  static global: Map<string, object> =
    (globalThis as { LocalReference?: Map<string, object> }).LocalReference ??
    ((globalThis as { LocalReference?: Map<string, object> }).LocalReference = new Map());

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

const updateIdentifier = handler<{ detail: { value: string } }, { identifier: string }>(
  ({ detail }, state) => {
    state.identifier = detail?.value ?? "";
  },
);

const updatePassword = handler<{ detail: { value: string } }, { password: string }>(
  ({ detail }, state) => {
    state.password = detail?.value ?? "";
  },
);

const authorize = handler<
  {},
  { credentials: TypeOf<typeof Credentials>; session: TypeOf<typeof Session> }
>(async (_, state) => {
  if (state.credentials.identifier !== "" && state.credentials.password !== "") {
    const agent = new AtpAgent({ service: "https://bsky.social" });
    const response = await agent.login({
      identifier: state.credentials.identifier,
      password: state.credentials.password,
    });

    if (!response.success) {
      state.session = { status: "error", reason: response };
    } else {
      state.session = { status: "ready", agent: LocalReference.for(agent) };
    }
  }
});

const download = handler<
  {},
  { session: z.TypeOf<typeof ReadySession>; cursor: string; feed: unknown[] }
>(async (_, cells) => {
  const agent = LocalReference.resolve(cells.session.agent) as AtpAgent;
  const { data } = await agent.getTimeline({
    cursor: cells.cursor,
    limit: 3,
  });

  // Ok this is not ideal, but without this we run into various proxy problems
  const { feed, cursor } = JSON.parse(JSON.stringify(data));

  for (const item of feed) {
    cells.feed.push(item);
  }

  if (feed.cursor) {
    cells.cursor = cursor;
  }
  // When you read last page it appears that client does not give you a cursor
  // so we read it from the last post.record.createAt which it seems to
  // correspond to.
  else if (feed.length > 0) {
    cells.cursor = feed.at(-1).post.record.createdAt;
  }
});

const view = (state: z.TypeOf<typeof Model>, output: z.TypeOf<typeof Output>) =>
  ifElse(
    derive(state.session.status, (status) => status === "idle"),
    viewIdle(state),
    viewReadyOrFailed(state, output),
  );

const viewReadyOrFailed = (state: z.TypeOf<typeof Model>, output: z.TypeOf<typeof Output>) =>
  ifElse(
    derive(state.session.status, (status) => status === "ready"),
    viewReady(state as { session: z.TypeOf<typeof ReadySession>; cursor: string }, output),
    viewFailed(state as { session: z.TypeOf<typeof FailedSession> }),
  );

const viewIdle = ({ credentials, session }: z.TypeOf<typeof Model>) => (
  <os-container>
    Login
    <common-input
      value={credentials.identifier}
      placeholder="Username"
      oncommon-input={updateIdentifier({ identifier: credentials.identifier })}
    />
    <common-input
      value={credentials.password}
      placeholder="Password"
      password={true}
      oncommon-input={updatePassword({ password: credentials.password })}
    ></common-input>
    <sl-button outline variant="danger" onclick={authorize({ credentials, session })}>
      Next
    </sl-button>
  </os-container>
);

const viewReady = (
  { session, cursor }: { session: z.TypeOf<typeof ReadySession>; cursor: string },
  output: z.TypeOf<typeof Output>,
) => (
  <os-container>
    <p>Import from {cursor ?? "start"}</p>
    <div>
      <sl-button outline onclick={download({ session, cursor, feed: output.feed })}>
        Import
      </sl-button>
    </div>
    <div data-role="posts">{output.feed.map(viewPost)}</div>
    <pre>{derive(output.feed, (data) => (data ? JSON.stringify(data, null, 2) : ""))}</pre>
  </os-container>
);

const viewPost = ({ post }: AppBskyFeedDefs.FeedViewPost) => (
  <div data-uri={post.uri} data-cid={post.cid}>
    {viewAuthor(post.author)}
    {viewEmbed(post.embed! ?? {})}
  </div>
);

const viewAuthor = (author: AppBskyFeedDefs.PostView["author"]) => (
  <div>
    <p title={author.did}>
      <img src={author.avatar} style="width: 42px; height: 42px; border-radius: 21px;" />
      <span>{author.displayName ?? ""}</span>
      <code>{author.handle}</code>
    </p>
  </div>
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
    <video width={embed.aspectRatio?.width} heigh={embed.aspectRatio?.height} src={embed.playlist}>
      <img src={embed.thumbnail} alt={embed.alt} />
    </video>
  </div>
);
const viewRecordEmbed = (embed: AppBskyEmbedRecord.View) => <div>{embed}</div>;
const viewRecordWithMedia = (embed: AppBskyEmbedRecordWithMedia.View) => <div>{embed}</div>;
const viewUnknownEmbed = (embed: { $type: string; [k: string]: unknown }) => (
  <div>
    <pre>{derive(embed, (embed) => JSON.stringify(embed))}</pre>
  </div>
);

const viewFailed = ({ session }: { session: z.TypeOf<typeof FailedSession> }) => (
  <os-container>
    Error
    <pre>{derive(session, (session) => JSON.stringify(session))}</pre>
  </os-container>
);

// const getRecent = derive(state, (state: z.TypeOf<typeof Model>) => {
//   if (state.session.status !== "ready") { return null }
//   const agent = LocalReference.resolve(state.session.agent);
//   const { data } = await agent.getTimeline({
//     limit: 30,
//   });
//   return data;
// });
export default recipe(Model, Output, (input) => {
  const feed = cell([]) as OpaqueRef<any[]>;
  // const data = getRecent(state);

  return {
    [NAME]: "Bluesky Importer",
    [UI]: <div>{view(input, { feed })}</div>,
    feed,
    data: feed,
  };
});
