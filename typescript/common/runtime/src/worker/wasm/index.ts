import { RuntimeWorkerContext } from '../index.js';
import { RuntimeWasmWorker } from './runtime.js';

(self as any).runtimeWorkerContext = new RuntimeWorkerContext(
  new RuntimeWasmWorker()
);
