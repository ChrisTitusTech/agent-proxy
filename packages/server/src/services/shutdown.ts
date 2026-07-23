export interface ShutdownOperations {
  stopAccepting: () => Promise<void>;
  stopProviders: () => Promise<void>;
  terminateChildren: () => Promise<void>;
  closeState: () => void | Promise<void>;
  drainTimeoutMs: number;
  forceTimeoutMs?: number;
}

export interface ShutdownResult {
  drained: boolean;
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const completed = promise.then(() => true);
  const result = await Promise.race([completed, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function shutdownServer(operations: ShutdownOperations): Promise<ShutdownResult> {
  const closePromise = operations.stopAccepting();
  const drained = await settlesWithin(closePromise, operations.drainTimeoutMs);

  await operations.stopProviders();
  await operations.terminateChildren();

  if (!drained) {
    await settlesWithin(closePromise, operations.forceTimeoutMs ?? 5_000);
  }
  await operations.closeState();
  return { drained };
}
