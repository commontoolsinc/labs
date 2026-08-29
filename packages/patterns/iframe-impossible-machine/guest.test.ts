import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

describe("Impossible Machine document shell", () => {
  it("keeps React Flow measurement and overlay layers explicitly sized", async () => {
    const html = await Deno.readTextFile(
      new URL("./guest.html", import.meta.url),
    );

    expect(html).toMatch(
      /\.workspace\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
    );
    expect(html).toMatch(
      /\.flow-shell\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
    );
    expect(html).toMatch(
      /\.react-flow__node-actuator\s*{[^}]*width:\s*218px;/s,
    );
    expect(html).toMatch(
      /\.react-flow__edgelabel-renderer,[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
    );
    expect(html).toMatch(
      /\.react-flow__viewport-portal[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
    );
  });

  it("mounts the tested control and selection lifecycle in each node", async () => {
    const source = await Deno.readTextFile(
      new URL("./guest.tsx", import.meta.url),
    );

    expect(source).toContain(
      "<div {...nodeControlBoundaryProps()}>{children}</div>",
    );
    expect(source).toContain("await updateLatestValue(");
    expect(source).toContain("void tracker.request(");
    expect(source).toContain("const actionRunner = React.useRef(");
    expect(source).toContain("const runNodeAction = actionRunner.runNode");
    expect(source).toContain("const located = findAppendOnlyItem(");
    expect(source).not.toContain("nodesCell.key(index).resolve()");
    expect(source).toContain("nodesDraggable");
    expect(source).toContain("nodesConnectable");
    expect(source).toContain("elementsSelectable");
    expect(source).not.toContain("nodesDraggable={!pending}");
  });
});
