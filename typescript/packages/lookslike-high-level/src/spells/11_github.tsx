import {
  h,
  behavior,
  $,
  Reference,
  select,
  Session,
  refer,
} from "@commontools/common-system";

import { fetch, REQUEST, RESPONSE } from "../effects/fetch.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { addTag } from "../sugar/tags.js";
import { Collection } from "../sugar.js";

const IMPORT_REQUEST = 'import/request'

export const Commits = Collection.of({
  sha: $.sha,
  commit: {
    author: {
      name: $.name,
      email: $.email,
      date: $.date
    },
    message: $.message
  }
});

const getCommits =
  (url: string) => `https://api.github.com/repos${new URL(url).pathname}/commits?per_page=50`

export default behavior({
  defaultUrl: select({ self: $.self })
    .not(q => q.match($.self, "url", $._))
    .assert(({ self }) => [self, 'url', 'https://github.com/user/repo'])
    .commit(),

  form: select({ self: $.self, url: $.url })
    .match($.self, "url", $.url)
    .not(q => q.match($.self, IMPORT_REQUEST, $._))
    .render(({ self, url }) => (
      <div title="Github Commits Fetcher">
        <common-input value={url} oncommon-input="~/on/change-url" />
        <button onclick="~/on/send-request">Fetch Commits</button>
      </div>
    )).commit(),

  onSendRequest: select({ self: $.self, event: $.event, url: $.url })
    .match($.self, "~/on/send-request", $.event)
    .match($.self, "url", $.url)
    .update(({ self, url }: { self: Reference, url: string }) => {
      return [
        fetch(
          self,
          IMPORT_REQUEST,
          new Request(getCommits(url), {
            method: "GET",
            headers: {
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
            },
          }),
        ).json(),
      ];
    }).commit(),

  inFlight: select({ self: $.self, request: $.request, status: $.status, url: $.url })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, REQUEST.STATUS, $.status)
    .match($.self, "url", $.url)
    .not(q => q.match($.request, RESPONSE.JSON, $._))
    .render(({ self, status, url }) => (
      <div title="Github Commits" entity={self}>
        <h1>{status} - Fetching commits from <i>{url}</i></h1>
        <button onclick="~/on/reset">Reset</button>
      </div>
    )).commit(),

  showResult: select({ self: $.self, request: $.request, commits: Commits.select })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, RESPONSE.JSON, $.response)
    .clause(Commits.match($.response))
    .render(({ self, commits }) => {
      const collection = Commits.from(commits)
      const items = [...collection]

      return (
        <div title="Github Commits" entity={self}>
          <h1>Commit History</h1>
          <ol>
            {...items.map(commit => (
              <li key={commit.sha} style={{
                marginBottom: '16px',
                borderBottom: '1px solid #e1e4e8',
                padding: '8px 0'
              }}>
                <div style={{
                  fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
                  fontSize: '14px',
                  lineHeight: '1.5'
                }}>
                  <code style={{
                    fontFamily: 'SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace',
                    fontSize: '12px',
                    backgroundColor: '#f6f8fa',
                    padding: '2px 4px',
                    borderRadius: '3px'
                  }}>{commit.sha.substring(0, 7)}</code>
                  <div style={{ marginTop: '4px' }}>
                    <strong>{commit.commit.message}</strong>
                  </div>
                  <div style={{
                    color: '#586069',
                    fontSize: '12px',
                    marginTop: '4px'
                  }}>
                    {commit.commit.author.name} committed on {new Date(commit.commit.author.date).toLocaleDateString()}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <button onclick="~/on/reset">Reset</button>
        </div>
      )
    })
    .commit(),

  onComplete: select({ self: $.self, request: $.request, content: $.content })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, REQUEST.STATUS, 'Complete')
    .match($.request, RESPONSE.JSON, $.response)
    .match($.response, 'content', $.content)
    .update(({ self, content }) => {
      return [
        ...addTag(content, '#github-commits')
      ]
    })
    .commit(),

  onReset: select({ self: $.self, event: $.event, request: $.request })
    .match($.self, "~/on/reset", $.event)
    .match($.self, IMPORT_REQUEST, $.request)
    .update(({ self, request }) => {
      return [{ Retract: [self, IMPORT_REQUEST, request] }];
    })
    .commit(),

  onChangeUrl: select({ self: $.self, event: $.event })
    .match($.self, "~/on/change-url", $.event)
    .upsert(({ self, event }) => {
      // common-input gives us events with easy to read values
      return [self, 'url', Session.resolve<CommonInputEvent>(event).detail.value]
    })
    .commit(),
});
