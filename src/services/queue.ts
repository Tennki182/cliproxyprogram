import { getConfig } from '../config.js';
import { logWarn } from './log-stream.js';

const MAX_QUEUE_SIZE = 100;

interface QueueItem<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  retries: number;
}

const queue: QueueItem<any>[] = [];
let running = 0;

function getConcurrency(): number {
  try {
    const config = getConfig();
    return config.queue.concurrency;
  } catch {
    return 5;
  }
}

function is429(error: any): boolean {
  const msg = String(error?.message || '');
  return msg.includes('(429)') || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
}

async function processQueue(): Promise<void> {
  const concurrency = getConcurrency();
  while (queue.length > 0 && running < concurrency) {
    const item = queue.shift();
    if (!item) break;

    const config = getConfig();
    const maxRetries = config.retry.maxRetries;

    running++;
    try {
      const result = await item.execute();
      item.resolve(result);
    } catch (error: any) {
      if (is429(error) && item.retries < maxRetries) {
        item.retries++;
        const delay = Math.min(
          config.retry.baseIntervalMs * Math.pow(config.retry.backoffMultiplier, item.retries - 1),
          config.retry.maxIntervalMs
        );
        logWarn(`429 限流，第 ${item.retries} 次重试，${delay}ms 后重试`);
        // Schedule re-queue after delay
        setTimeout(() => {
          if (queue.length >= MAX_QUEUE_SIZE) {
            item.reject(new Error('请求队列已满，请稍后重试'));
            return;
          }
          queue.push(item);
          processQueue();
        }, delay);
      } else {
        item.reject(error);
      }
    } finally {
      running--;
    }

    // Process next (yield to event loop to avoid deep call stack)
    setImmediate(() => processQueue());
  }
}

/**
 * Enqueue a request for execution.
 * - Memory queue with max 100 pending requests.
 * - On 429: re-queues with exponential backoff delay.
 * - Works with rotation: retry calls acquireCredential() which picks a fresh account.
 */
export function enqueue<T>(execute: () => Promise<T>): Promise<T> {
  if (queue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new Error('请求队列已满，请稍后重试'));
  }

  return new Promise<T>((resolve, reject) => {
    queue.push({ execute, resolve, reject, retries: 0 });
    processQueue();
  });
}

/** Get current queue stats. */
export function getQueueStats(): { pending: number; running: number } {
  return { pending: queue.length, running };
}
