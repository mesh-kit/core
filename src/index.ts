export { MeshClient } from "./client";
export { MeshServer, type MeshContext, type SocketMiddleware } from "./server";
export { type CodeError } from "./common/codeerror";

import fjp from "fast-json-patch";
export const { applyPatch } = fjp;
