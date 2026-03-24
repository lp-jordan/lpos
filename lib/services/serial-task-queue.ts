export class SerialTaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => task());
    this.tail = run.catch(() => {});
    return run;
  }
}
