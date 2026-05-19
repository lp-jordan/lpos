import type { ChildProcess } from 'node:child_process';

/** token → jobId: lets the cancel endpoint look up the job without a DB round-trip. */
export const activeDeliveryJobs = new Map<string, string>()

/** jobId → ffmpeg child process: lets abort kill an in-progress transcode immediately. */
export const activeFfmpegProcs  = new Map<string, ChildProcess>()
