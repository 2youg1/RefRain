// Debug-window bridge. Release builds do not register these commands.
// Keep this file separate from bindings.gen.ts so production generation cannot
// advertise a test seam as a release capability.

import { invoke } from "@tauri-apps/api/core";
import type { DocumentRow, ProjectOpenedDto, RootKind } from "../generated/bindings.gen";

export const debugCommands = {
  adoptRoot: (path: string, kind: RootKind): Promise<ProjectOpenedDto> =>
    invoke("debug_adopt_root", { path, kind }),
  createProject: (parent: string, name: string): Promise<ProjectOpenedDto> =>
    invoke("debug_create_project", { parent, name }),
  importMaterial: (rootId: string, sourcePath: string): Promise<DocumentRow> =>
    invoke("debug_import_material", { rootId, sourcePath }),
  importManuscript: (rootId: string, sourcePath: string): Promise<DocumentRow> =>
    invoke("debug_import_manuscript", { rootId, sourcePath }),
};
