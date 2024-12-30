import {
  derive,
  type OpaqueRef,
  UI,
  ifElse,
  select,
  Spell,
  doc,
  $
} from "@commontools/common-builder";
import { h } from "@commontools/common-html";

/**
 * Plan to rewrite this on top of recipe stack
 *
 * For now assume it won't be sandboxed, so `this` will at runtime refer to the
 * instance of the Spell. Note though that this is all on opaqueref space, but
 * the recipe-opaqueref is a transparent wrapper around life cells, so it should
 * work.
 *
 * .compile() will call `recipe` with a callback that constructs all the opaque
 * refs and so on.
 *
 * E.g. this.update({ ... }) should be possible to do, we look up the cells
 * in our cell table and update them.
 *
 * A few changes:
 * - formulating queries is select(($) => ({ foo: $.foo }))
 *   - would be nicer if we'd instead have this.<state> instead of $.foo?
 *     that's a bunch more work though.
 *   - we could also allow a shortcut like { foo, bar: ["bar", "baz"] }
 * - addEventHandler just gets the whole state
 * - addRule needs the builder syntax:
 *   - `event(name)` adds a stream of that name to parameters
 *   - `select(($) => ({ foo: $.foo }))` adds a query to the rule
 *   - `with(schema)` gets all keys from the schema
 *   - `match(condition)` adds a condition to the rule
 *   - First step: Just assume `select`.
 * - handlers just get values
 * - event handlers use this.update() without self to update the state
 * - derive rules just return new values
 */

type Meta = {
  category: string;
  submittedAt: string;
};

class MetadataSpell extends Spell<Meta> {
  constructor() {
    super();

    this.addEventListener("update", (self, ev) => {
      this.update(
        self,
        doc({
          category: ev.detail.value,
          submittedAt: new Date().toISOString(),
        }),
      );
    });
  }

  override init() {
    return {
      category: "Default category",
      submittedAt: "n/a",
    };
  }

  override render({ category, submittedAt }: OpaqueRef<Meta>) {
    console.log("Metadata render", category, submittedAt);
    return (
      <div>
        <h2>Metadata</h2>
        <common-input
          type="text"
          name="category"
          value={category}
          oncommon-blur={this.dispatch("update")}
        />
        <small>{submittedAt}</small>
      </div>
    );
  }
}

const metadata = new MetadataSpell().compile("Metadata");

function Metadata({ meta }: { meta: Meta }, _children: any) {
  return metadata(meta ?? {})[UI];
}

type CommentsState = {
  title: string;
  description: string;
  meta: Meta | null;
  metaLength: number;
};

export class CommentBoxSpell extends Spell<CommentsState> {
  constructor() {
    super();

    this.addEventListener("random", self => {
      console.log("random", self);

      const metadata: Meta = doc({
        category: "Demo category " + Math.random(),
        submittedAt: new Date().toISOString(),
      });

      this.update(self, { meta: metadata });
    });

    this.addEventListener("submit", self => {
      console.log("submit", self);
    });

    this.addRule(
      select({ meta: $.meta }),
      ({ meta }) => ({ metaLength: meta?.length ?? 0 }),
    );
  }

  override init() {
    return {
      title: "Class Syntax Demo",
      description: "It has an embedded doc!",
      meta: null,
      metaLength: 0,
    };
  }

  override render({ description, title, meta }: OpaqueRef<CommentsState>) {
    return (
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
        <pre>{derive(meta, meta => JSON.stringify(meta, null, 2))}</pre>
        {ifElse(
          meta,
          <div>
            <Metadata meta={meta!} />
          </div>,
          <div>No meta</div>,
        )}
        <common-form onsubmit={this.dispatch("submit")}>
          <common-input type="text" name="message" />
        </common-form>
        <common-button onclick={this.dispatch("random")}>Random</common-button>
      </div>
    );
  }
}

const commentBox = new CommentBoxSpell().compile("Comment Box");

(window as any).metadata = metadata;
(window as any).commentBox = commentBox;

export default commentBox;
