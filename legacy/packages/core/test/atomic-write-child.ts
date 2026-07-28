import { type AtomicWriteCheckpoint, replaceFileAtomically } from "../src/index.ts";

const [, , path, checkpoint] = process.argv;
const checkpoints = new Set<AtomicWriteCheckpoint>([
  "written",
  "file-synced",
  "renamed",
  "directory-synced",
]);

if (!path || !checkpoints.has(checkpoint as AtomicWriteCheckpoint)) process.exit(64);

replaceFileAtomically(path, "完整新版。\n", (reached) => {
  if (reached === checkpoint) process.kill(process.pid, "SIGKILL");
});
process.exit(65);
