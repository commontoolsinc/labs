import { CTCellTester } from "./ct-cell-tester.ts";

if (!customElements.get("ct-cell-tester")) {
  customElements.define("ct-cell-tester", CTCellTester);
}

export { CTCellTester };