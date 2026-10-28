// Lightweight request timing: mark named checkpoints, emit them as ms-since-start.
// Used for structured latency logs (e.g. `chat_timing`) so slow stages can be pinpointed.
export class Stopwatch {
  private readonly start = performance.now();
  private readonly marks: Record<string, number> = {};

  /** Records the elapsed time for `name` (first mark wins, so repeated calls are harmless). */
  mark(name: string): void {
    if (!(name in this.marks)) this.marks[name] = Math.round(performance.now() - this.start);
  }

  toJSON(): Record<string, number> {
    return { ...this.marks };
  }
}
