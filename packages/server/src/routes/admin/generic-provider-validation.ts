import type { GenericCliProviderConfig } from '@agent-proxy/shared';

export function hasValidGenericQueueLimits(
  config: Pick<
    GenericCliProviderConfig,
    'max_concurrent' | 'max_queue_size' | 'max_queue_wait_ms'
  >,
): boolean {
  return Number.isSafeInteger(config.max_concurrent)
    && config.max_concurrent >= 1
    && (
      config.max_queue_size === undefined
      || (
        Number.isSafeInteger(config.max_queue_size)
        && config.max_queue_size >= 0
      )
    )
    && (
      config.max_queue_wait_ms === undefined
      || (
        Number.isSafeInteger(config.max_queue_wait_ms)
        && config.max_queue_wait_ms >= 0
      )
    );
}
