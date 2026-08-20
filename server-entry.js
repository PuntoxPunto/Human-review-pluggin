import { register } from "node:module";

register("./src/web-review/runner-loader.mjs", import.meta.url);
await import("./server.js");
