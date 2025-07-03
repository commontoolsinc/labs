import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";

import "./views/RootView.ts";
import "./views/HeaderView.ts";
import "./views/BodyView.ts";
import "./views/LoginView.ts";

console.log(`ENVIRONMENT=${ENVIRONMENT}`);
console.log(`API_URL=${API_URL}`);
console.log(`COMMIT_SHA=${COMMIT_SHA}`);
