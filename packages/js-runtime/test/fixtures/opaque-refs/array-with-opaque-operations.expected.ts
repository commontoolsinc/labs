/// <cts-enable />
import { cell, derive } from "commontools";
const a = cell<number>(10);
const b = cell<number>(20);
const c = [commontools_1.derive(a, _v1 => _v1 + 1), commontools_1.derive(b, _v1 => _v1 - 1)];