/**
 * That an element of the thread's filtered, sorted `computed()` still carries
 * the identity of the stored record it came from.
 *
 * The reader renders comments and links from a `computed()` that filters out
 * stamped records and sorts what is left, and the browser's retraction
 * controls are bound to the elements of those views. Whether such an element
 * still addresses the array it was derived from is the property those controls
 * stand on: bound to a copy, a control would stamp something no reader shows,
 * and the thread would be unchanged while the click looked as though it
 * worked.
 *
 * `removeComment` and `removeLink` are the oracles rather than a bespoke
 * assertion, because they already prove membership with `equals()` against the
 * stored positions and reject loudly when it fails. Handing them an element
 * taken from the view therefore answers the question with a pass or a throw.
 *
 * The negative half lives in topics-rejections.test.tsx, where a structural
 * copy of a real stored comment is refused — the case that separates identity
 * from content, since a copy satisfies every content-based check.
 *
 * This pins the model property. That the SHIPPED controls are bound to it is a
 * separate question, and it is proven through a real click in
 * integration/topic-retraction-controls.test.ts.
 */
import { action, assert, computed, pattern, TESTS } from "commonfabric";
import Topic from "./topic.tsx";

export default pattern(() => {
  const topic = Topic({ title: "View identity" });

  const add_comments = action(() => {
    topic.addComment.send({ body: "first", agentName: "Sol" });
    topic.addComment.send({ body: "second", agentName: "Sol" });
    topic.addComment.send({ body: "third", agentName: "Sol" });
  });

  const add_links = action(() => {
    topic.addLink.send({
      kind: "web",
      url: "https://example.com/one",
      label: "one",
      agentName: "Sol",
    });
    topic.addLink.send({
      kind: "web",
      url: "https://example.com/two",
      label: "two",
      agentName: "Sol",
    });
  });

  // The shapes the reader renders from, rebuilt here so the elements handed to
  // the verbs below have been through the same filter and sort the browser's
  // rows go through.
  const commentsView = computed(() =>
    topic.comments.filter((c) => c.removedAt === undefined).toSorted((a, b) =>
      a.sentAt - b.sentAt
    )
  );
  const linksView = computed(() =>
    topic.links.filter((l) => l.removedAt === undefined)
  );

  // The middle one, not the first: an element whose position in the view and
  // position in the stored array can differ is the one that catches an
  // identity taken from the wrong array.
  const retract_second_comment = action(() => {
    const second = commentsView[1];
    if (second) {
      topic.removeComment.send({ comment: second, agentName: "Sol" });
    }
  });

  const retract_second_link = action(() => {
    const second = linksView[1];
    if (second) topic.removeLink.send({ link: second, agentName: "Sol" });
  });

  const assert_three_comments = assert(() => topic.comments.length === 3);

  // The write landed on the stored record, and on the RIGHT one: membership
  // alone would be satisfied by stamping any element.
  const assert_second_comment_stamped = assert(() => {
    const stored = topic.comments;
    const stamped = stored.filter((c) => c.removedAt !== undefined);
    return stored.length === 3 && stamped.length === 1 &&
      stamped[0]?.body === "second";
  });

  // What the reader is shown follows the stamp: the record stays, the count
  // and the view drop it.
  const assert_reader_sees_two = assert(() =>
    topic.commentCount === 2 &&
    topic.comments.filter((c) => c.removedAt === undefined).length === 2
  );

  const assert_second_link_stamped = assert(() => {
    const stored = topic.links;
    const stamped = stored.filter((l) => l.removedAt !== undefined);
    return stored.length === 2 && stamped.length === 1 &&
      stamped[0]?.url === "https://example.com/two";
  });

  return {
    [TESTS]: [
      { action: add_comments },
      { action: add_links },
      { assertion: assert_three_comments },
      { action: retract_second_comment },
      { assertion: assert_second_comment_stamped },
      { assertion: assert_reader_sees_two },
      { action: retract_second_link },
      { assertion: assert_second_link_stamped },
    ],
  };
});
