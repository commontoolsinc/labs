/// <cts-enable />
import { cell, derive } from "commontools";
const count = cell(0);
const next = commontools_1.derive(count, _v1 => _v1 + 1);