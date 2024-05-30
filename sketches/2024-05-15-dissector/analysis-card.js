import {
  LitElement,
  html,
  css,
} from "https://cdn.jsdelivr.net/npm/lit@3.1.3/+esm";
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10.9.0/+esm";
import cytoscape from "https://cdn.jsdelivr.net/npm/cytoscape@3.29.2/+esm";
mermaid.initialize({ startOnLoad: true });

class AnalysisCard extends LitElement {
  static get properties() {
    return {
      analysis: { type: Object },
    };
  }

  static get styles() {
    return css`
      :host {
        display: block;
        margin-bottom: 20px;
        padding: 10px;
        background-color: #f5f5f5;
        padding: 10px;
        border-radius: 4px;
        font-family: monospace;
        font-size: 12px;
      }

      h3 {
        margin-top: 0;
        font-family: monospace;
        font-size: 12px;
      }

      dl {
        margin: 0;
        font-family: monospace;
        font-size: 12px;
      }

      dt {
        font-weight: bold;
        display: inline;
        background-color: #e0e0e0;
        padding: 2px 4px;
        border-radius: 2px;
      }

      dd {
        margin-left: 10px;
        display: inline;
      }

      .mermaid {
        max-height: 100%;
      }

      .cytoscape {
        height: 380px;
      }
    `;
  }
  render() {
    const { analysis } = this;

    if (!analysis) {
      return html`<p>Analyzing...</p>`;
    }

    switch (analysis.type) {
      case "Summary":
        return this.renderSummaryAnalysis(analysis);
      case "TableOfContents":
        return this.renderTableOfContents(analysis);
      case "QuestionAnswer":
        return this.renderQuestionAnswer(analysis);
      case "ConceptMapDiagram":
        return this.renderConceptMap(analysis);
      case "SocialMapDiagram":
        return this.renderConceptMap(analysis);
      case "KnowledgeGraph":
        return this.renderKnowledgeGraph(analysis);
      case "PieChart":
        return this.renderPieChart(analysis);
      case "ColumnChart":
        return this.renderColumnChart(analysis);
      case "Author":
      default:
        return this.renderGenericAnalysis(analysis);
    }
  }

  renderConceptMap(analysis) {
    return html`
      <h3>Concept Map</h3>
      <pre class="mermaid">${this.analysis.src}</pre>
    `;
  }

  renderKnowledgeGraph(analysis) {
    return html`
      <h3>Knowledge Graph</h3>
      <pre class="cytoscape">${JSON.stringify(this.analysis)}</pre>
    `;
  }

  renderPieChart(analysis) {
    return html`
      <h3>Pie Chart</h3>
      <div class="pie-chart"></div>
    `;
  }

  renderColumnChart(analysis) {
    return html`
      <h3>Column Chart</h3>
      <div class="column-chart"></div>
    `;
  }

  firstUpdated() {
    if (
      this.analysis?.type === "PieChart" ||
      this.analysis?.type === "ColumnChart"
    ) {
      this.renderCharts();
    }

    if (this.analysis?.type === "KnowledgeGraph") {
      this.renderKnowledgeGraph();
    }
  }

  updated(changedProperties) {
    if (
      changedProperties.has("analysis") &&
      (this.analysis.type === "ConceptMapDiagram" ||
        this.analysis.type === "SocialMapDiagram")
    ) {
      this.renderMermaidDiagram();
      this.renderCharts();
    }

    if (
      changedProperties.has("analysis") &&
      this.analysis.type === "KnowledgeGraph"
    ) {
      this.renderCytoscapeGraph();
    }
  }

  renderCharts() {
    const { analysis } = this;

    if (analysis.type === "PieChart") {
      this.renderPieChartD3(analysis.data);
    } else if (analysis.type === "ColumnChart") {
      this.renderColumnChartD3(analysis.data);
    }
  }

  renderPieChartD3(data) {
    const width = 200;
    const height = 200;
    const radius = Math.min(width, height) / 2;

    const svg = d3
      .select(this.shadowRoot.querySelector(".pie-chart"))
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .append("g")
      .attr("transform", `translate(${width / 2}, ${height / 2})`);

    const color = d3.scaleOrdinal(d3.schemeCategory10);

    const pie = d3.pie().value((d) => d.value);
    const data_ready = pie(data);

    svg
      .selectAll("whatever")
      .data(data_ready)
      .enter()
      .append("path")
      .attr("d", d3.arc().innerRadius(0).outerRadius(radius))
      .attr("fill", (d) => color(d.data.name))
      .attr("stroke", "black")
      .style("stroke-width", "2px")
      .style("opacity", 0.7);
  }

  renderColumnChartD3(data) {
    const margin = { top: 20, right: 20, bottom: 30, left: 40 };
    const width = 300 - margin.left - margin.right;
    const height = 200 - margin.top - margin.bottom;

    const svg = d3
      .select(this.shadowRoot.querySelector(".column-chart"))
      .append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom)
      .append("g")
      .attr("transform", `translate(${margin.left}, ${margin.top})`);

    const x = d3.scaleBand().range([0, width]).padding(0.1);
    const y = d3.scaleLinear().range([height, 0]);

    x.domain(data.map((d) => d.name));
    y.domain([0, d3.max(data, (d) => d.value)]);

    svg
      .selectAll(".bar")
      .data(data)
      .enter()
      .append("rect")
      .attr("class", "bar")
      .attr("x", (d) => x(d.name))
      .attr("width", x.bandwidth())
      .attr("y", (d) => y(d.value))
      .attr("height", (d) => height - y(d.value));

    svg
      .append("g")
      .attr("transform", `translate(0, ${height})`)
      .call(d3.axisBottom(x));

    svg.append("g").call(d3.axisLeft(y));
  }

  async renderMermaidDiagram() {
    const mermaidDiv = this.shadowRoot.querySelector(".mermaid");
    if (mermaidDiv) {
      const { svg } = await mermaid.render(
        "mermaid-diagram",
        this.analysis.src.replaceAll("\\n", "\n")
      );
      mermaidDiv.innerHTML = svg;
    }
  }

  async renderCytoscapeGraph() {
    const mermaidDiv = this.shadowRoot.querySelector(".cytoscape");
    if (mermaidDiv) {
      // iterate over all elements and add any nodes that are missing but are referenced by edges
      let elements = this.analysis.elements;
      const nodes = elements.filter(
        (e) => (e.data.source === e.data.target) === undefined
      );
      const edges = elements.filter((e) => e.data.source || e.data.target);
      const nodeIds = nodes.map((n) => n.data.id);
      edges.forEach((edge) => {
        if (!nodeIds.includes(edge.data.source)) {
          elements = [
            {
              data: { id: edge.data.source, label: edge.data.source },
              group: "nodes",
            },
            ...elements,
          ];
        }
        if (!nodeIds.includes(edge.data.target)) {
          elements = [
            {
              data: { id: edge.data.target, label: edge.data.target },
              group: "nodes",
            },
            ...elements,
          ];
        }
      });

      cytoscape({
        container: mermaidDiv,
        elements: elements,
        style: [
          {
            selector: "edge",
            style: {
              label: "data(relationship)",
              "curve-style": "round-taxi",
              "target-arrow-shape": "triangle",
              "font-size": "8px",
              "text-background-color": "white",
              "text-background-opacity": 1,
              width: 1,
            },
          },
          {
            selector: "node",
            style: {
              label: "data(label)",
              "background-color": "data(color)",
            },
          },
        ],
        layout: {
          name: "cose",
          options: {
            animate: true,
            nodeOverlap: 20,
            idealEdgeLength: 1000,
          },
        },
      });
    }
  }

  renderAuthorAnalysis(analysis) {
    return html`
      <h3>Author Analysis</h3>
      <dl>
        <dt>Name:</dt>
        <dd>${analysis.name}</dd>
        <br />
        <dt>Age:</dt>
        <dd>${analysis.age}</dd>
      </dl>
    `;
  }

  renderTableOfContents(analysis) {
    return html`
      <h3>Table of Contents</h3>
      ${this.renderTableOfContentsEntries(analysis.sections)}
    `;
  }

  renderTableOfContentsEntries(entries, level = 1) {
    return html`
      <ol style="list-style-type: ${level === 1 ? "decimal" : "lower-alpha"};">
        ${entries.map(
          (entry) => html`
            <li>
              ${entry.title}
              ${entry.children?.length ?? 0 > 0
                ? this.renderTableOfContentsEntries(entry.children, level + 1)
                : ""}
            </li>
          `
        )}
      </ol>
    `;
  }

  renderSummaryAnalysis(analysis) {
    return html`
      <h3>Summary Analysis</h3>
      <dl>
        <dt>Executive Summary:</dt>
        <dd>${analysis.executiveSummary}</dd>
        <br />
        <dt>Credibility:</dt>
        <dd>${analysis.credibility}</dd>
        <br />
        <dt>Readability:</dt>
        <dd>${analysis.readability}</dd>
        <br />
        <dt>Sentiment:</dt>
        <dd>${analysis.sentiment.join(", ")}</dd>
      </dl>
    `;
  }

  renderGenericAnalysis(analysis) {
    return html` ${this.renderObjectProperties(analysis)} `;
  }

  renderObjectProperties(obj) {
    return html`
      <dl>
        ${Object.entries(obj)
          .filter(([k, _]) => k[0] != "_")
          .map(
            ([key, value]) => html`
              <dt>${key}:</dt>
              ${this.renderPropertyValue(value)}<br />
            `
          )}
      </dl>
    `;
  }

  renderPropertyValue(value) {
    if (Array.isArray(value)) {
      return html`<dd>
        <ul>
          ${value.map(
            (item) => html`<li>${this.renderPropertyValue(item)}</li>`
          )}
        </ul>
      </dd>`;
    } else if (typeof value === "object" && value !== null) {
      return html`<dd>${this.renderObjectProperties(value)}</dd>`;
    } else {
      return html`<dd>${value}</dd>`;
    }
  }

  renderQuestionAnswer(analysis) {
    return html`
      <h3>Question and Answer</h3>
      <dl>
        <dt>Question:</dt>
        <dd>${analysis.question}</dd>
        <br />
        <dt>Answer:</dt>
        ${analysis.answer.map(
          (answer) => html`
            <dd>
              <p>${answer.statement}</p>
              ${answer.substring_quote.length > 0
                ? html`
                    <blockquote style="font-family: monospace;">
                      ${answer.substring_quote.join("<br>")}
                    </blockquote>
                  `
                : ""}
            </dd>
          `
        )}
      </dl>
    `;
  }
}

customElements.define("analysis-card", AnalysisCard);
