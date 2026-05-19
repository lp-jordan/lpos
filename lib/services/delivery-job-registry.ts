import type { ChildProcess } from 'node:child_process';

/** token → jobId: lets the cancel endpoint look up the job without a DB round-trip. */
export const activeDeliveryJobs = new Map<string, string>()

/** jobId → ffmpeg child process: lets abort kill an in-progress transcode immediately. */
export const activeFfmpegProcs  = new Map<string, ChildProcess>()

/** Send SIGTERM to the ffmpeg proc for jobId, escalating to SIGKILL after 5 s if still alive. */
export function killFfmpegProc(jobId: string): void {
  const proc = activeFfmpegProcs.get(jobId)
  if (!proc) return
  proc.kill('SIGTERM')
  setTimeout(() => {
    if (activeFfmpegProcs.has(jobId)) proc.kill('SIGKILL')
  }, 5_000)
}
