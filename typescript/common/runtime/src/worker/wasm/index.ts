import { RuntimeContext } from '../index.js';
import { RuntimeWasmWorker } from './runtime.js';

(self as any).runtimeContext = new RuntimeContext(new RuntimeWasmWorker());
