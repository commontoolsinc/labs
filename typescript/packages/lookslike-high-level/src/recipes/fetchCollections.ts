import { html } from "@commontools/common-html";
import {
  recipe,
  fetchData,
  UI,
  NAME,
  ifElse,
  lift,
} from "@commontools/common-builder";

interface Item {
  id: string;
  title: string;
}

const asKvPairs = lift((obj: object) => Object.entries(obj || {}).map(([k, v]) => `${k}: ${v}`).join(", "));

const asTable = lift((inputData: object | object[]) => {
  const data = Array.isArray(inputData) ? inputData : [inputData];
  const headers = Array.from(new Set((data.flatMap(obj => Object.keys(obj || {})))));

  return html`
    <table>
      <thead>
        <tr>
          ${headers.map(header => html`<th>${header}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${data.map(obj => html`
          <tr>
            ${headers.map(header => html`<td>${obj[header] || ''}</td>`)}
          </tr>
        `)}
      </tbody>
    </table>
  `;
});

export const fetchCollections = recipe<{ url: string }>(
  "Fetch Collections",
  ({ url }) => {
    const { result } = fetchData<any>({
      url
    });

    return {
      [NAME]: "Fetch Collections",
      [UI]: html`<div>
        ${ifElse(
          result,
          html`<div>
            ${asTable(result)}
          </div>`,
          html`<div>Loading...</div>`
        )}
      </div>`,
      result,
    };
  }
);
