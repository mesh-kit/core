export { MeshClient, Status } from "./client";
export { Connection } from "./connection";
export { CodeError } from "../common/codeerror";

import fjp from "fast-json-patch";
export const { applyPatch } = fjp;
