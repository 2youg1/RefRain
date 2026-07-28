import { randomUUID } from "node:crypto";
import type { TextHeadId } from "./domain.ts";

export const newTextHeadId = (): TextHeadId => `th:${randomUUID()}`;
