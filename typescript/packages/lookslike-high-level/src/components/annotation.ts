import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ref, createRef } from "lit/directives/ref.js";
import { render, View } from "@commontools/common-html";
import { dataGems, UI } from "../data.js";
import {
  run,
  cell,
  CellImpl,
  getCellReferenceOrValue,
} from "../runner/index.js";
import { annotation } from "../recipes/annotation.js";

// TODO: Should instead be a curried recipe that is inlined as component
@customElement("common-annotation")
export class CommonAnnotation extends LitElement {
  @property({ type: String })
  query?: string;

  @property({ type: Number })
  target?: number;

  @property({ type: Object })
  data: { [key: string]: any } | undefined = undefined;

  private annotation?: CellImpl<{ [UI]: any }>;
  private annotationRef = createRef<HTMLAnchorElement>();

  private queryCell: CellImpl<string | undefined> = cell();
  private targetCell: CellImpl<number | undefined> = cell();
  private dataCell: CellImpl<{ [key: string]: any } | undefined> = cell();

  override render() {
    return html`<div ${ref(this.annotationRef)}></div>`;
  }

  override async updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has("query")) this.queryCell.send(this.query);
    if (changedProperties.has("target")) this.targetCell.send(this.target);
    if (changedProperties.has("data"))
      this.dataCell.send(getCellReferenceOrValue(this.data));

    if (!this.annotation && this.annotationRef.value) {
      this.annotation = run(annotation, {
        query: this.queryCell,
        target: this.targetCell,
        data: this.dataCell,
        gems: dataGems,
      });

      render(
        this.annotationRef.value,
        this.annotation.asSimpleCell<{ [UI]: View }>().key(UI).get()
      );
    }
  }
}
