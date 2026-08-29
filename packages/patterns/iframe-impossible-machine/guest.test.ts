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

    expect(source).toMatch(
      /className="node-parameters nodrag nopan"\s+onClick={stopNodeControlPropagation}/,
    );
    expect(source).toContain(
      "selectionRequestTracker.current.request(nodeId, writeSelection)",
    );
  });
});
