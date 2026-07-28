export const HERDR_WORKER_PROTOCOL = 1;

export interface HerdrWorkerStart {
  type: 'start';
  protocol: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
}

export interface HerdrWorkerCancel {
  type: 'cancel';
}

export type HerdrWorkerCommand = HerdrWorkerStart | HerdrWorkerCancel;

export type HerdrWorkerEvent =
  | { type: 'ready'; protocol: number; pid: number }
  | { type: 'started'; pid: number }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number; signal?: string }
  | { type: 'error'; message: string };
