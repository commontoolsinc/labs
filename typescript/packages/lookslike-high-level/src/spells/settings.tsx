import { h, behavior, $, select, Session } from "@commontools/common-system";
import { fromString } from "merkle-reference";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import {
  addTag,
  Collection,
  defaultTo,
  event,
  isEmpty,
  Transact,
} from "../sugar.js";
import { attemptAuth, getToken, isGmailAuthenticated } from "../gmail.js";
import {
  Gmail,
  listMessages,
  makeEmail,
  REQUEST,
  RESPONSE,
  sendMessage,
} from "../effects/gmail.jsx";

const GMAIL_REQUEST = "~/gmail";

export const Emails = Collection.of({
  id: $.id,
  threadId: $.threadId,
  snippet: $.snippet,
});

export const Headers = Collection.of({
  name: $.name,
  value: $.value,
});

const resolveRequest = select({
  self: $.self,
  request: $.request,
  status: $.status,
})
  .match($.self, GMAIL_REQUEST, $.request)
  .match($.request, REQUEST.STATUS, $.status);
const resolveRequestContent = select({
  content: $.content,
  emails: Emails.select,
})
  .match($.request, RESPONSE.JSON, $.content)
  .clause(Emails.match($.content));

export const settings = behavior({
  view: select({ self: $.self })
    .render(({ self }) => (
      <div title="Settings" entity={self}>
        <div>
          <h2>Connect Services</h2>

          <div>
            <h3>Bluesky</h3>
            <form onSubmit="~/on/bluesky-auth">
              <div>
                <label>Handle</label>
                <common-input
                  type="text"
                  name="handle"
                  oncommon-blur="~/on/bluesky-handle"
                />
              </div>
              <div>
                <label>Password</label>
                <common-input
                  type="password"
                  name="password"
                  oncommon-blur="~/on/bluesky-password"
                />
              </div>
              <button type="submit">Connect Bluesky</button>
            </form>
          </div>

          <div>
            <h3>Gmail</h3>
            {isGmailAuthenticated() ? (
              `Connected`
            ) : (
              <button onclick="~/on/gmail-auth">Connect Gmail Account</button>
            )}

            {isGmailAuthenticated() ? (
              <div>
                <pre>{JSON.stringify(getToken(), null, 2)}</pre>
                <button onclick="~/on/test-fetch-gmail">Fetch Emails</button>
                <button onclick="~/on/test-send-gmail">Try Send Email</button>
              </div>
            ) : (
              ""
            )}
          </div>

          <div>
            <h3>Spotify</h3>
            <button onclick="~/on/spotify-auth">Connect Spotify Account</button>
          </div>

          <div>
            <h3>GitHub</h3>
            <button onclick="~/on/github-auth">Connect GitHub Account</button>
          </div>
        </div>
      </div>
    ))
    .commit(),

  onBlueskyAuth: event("~/on/bluesky-auth")
    .update(({ self, event }) => {
      const formData = Session.resolve<CommonInputEvent>(event).detail;
      return [{ Upsert: [self, "blueskyAuth", formData.value] }];
    })
    .commit(),

  onBlueskyHandle: event("~/on/bluesky-handle")
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "blueskyHandle", val] }];
    })
    .commit(),

  onBlueskyPassword: event("~/on/bluesky-password")
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "blueskyPassword", val] }];
    })
    .commit(),

  onGmailAuth: event("~/on/gmail-auth")
    .update(({ self }) => {
      // Trigger Gmail OAuth flow
      attemptAuth();
      return [{ Upsert: [self, "gmailAuthStarted", true] }];
    })
    .commit(),

  onSpotifyAuth: event("~/on/spotify-auth")
    .update(({ self }) => {
      // Trigger Spotify OAuth flow
      return [{ Upsert: [self, "spotifyAuthStarted", true] }];
    })
    .commit(),

  onGithubAuth: event("~/on/github-auth")
    .update(({ self }) => {
      // Trigger GitHub OAuth flow
      return [{ Upsert: [self, "githubAuthStarted", true] }];
    })
    .commit(),

  onTestFetchGmail: event("~/on/test-fetch-gmail")
    .update(({ self }) => {
      return [listMessages(self, GMAIL_REQUEST, "me", "")];
    })
    .commit(),

  onTestSendGmail: event("~/on/test-send-gmail")
    .update(({ self }) => {
      return [
        sendMessage(
          self,
          GMAIL_REQUEST,
          "me",
          makeEmail(
            "bfollington@gmail.com",
            "Test Email",
            "This is a test email",
          ),
        ),
      ];
    })
    .commit(),

  onComplete: resolveRequest
    .with(resolveRequestContent)
    .match($.request, REQUEST.STATUS, "Complete")
    .update(({ self, content, emails }) => {
      console.log({ self, content, emails });
      return [...addTag(content, "#gmail")];
    })
    .commit(),
});
