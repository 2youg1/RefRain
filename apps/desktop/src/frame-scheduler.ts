type FrameTask = () => void;

const pending = new Map<string, FrameTask>();
let requested: number | null = null;

const flush = (): void => {
  requested = null;
  const tasks = [...pending.values()];
  pending.clear();
  for (const task of tasks) task();
};

/** Keep only the latest visual write for a named concern in the next frame. */
export function scheduleFrame(key: string, task: FrameTask): void {
  pending.set(key, task);
  if (requested !== null) return;
  requested = requestAnimationFrame(flush);
}

export function cancelScheduledFrame(key: string): void {
  pending.delete(key);
}
