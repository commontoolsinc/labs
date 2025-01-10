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
      select({ category: $.meta.category, title: $.title }),
      ({ self, category, title }) =>
        this.update(self, { metaLength: title.length + (category ?? "").length })
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

  override render({ description, title, meta, metaLength }: OpaqueRef<CommentsState>) {
    return (
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
        <p>metaLength: {metaLength}</p>
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

export default commentBox;
