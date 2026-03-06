import { getConfig } from '../config.js';
import { formatErrorMessage, logWarn } from './log-stream.js';

const MAX_QUEUE_SIZE = 100;
const MAX_RETRIES = 10; // 增加最大重试次数

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

// 所有错误都允许重试
function isRetryable(_error: any): boolean {
  return true;
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
      // 所有错误都重试，直到达到最大次数
      if (isRetryable(error) && item.retries < Math.min(maxRetries, MAX_RETRIES)) {
        item.retries++;
        // 更短的重试间隔：基础 200ms，最大 2s，指数退避
        const baseDelay = 200;
        const maxDelay = 2000;
        const delay = Math.min(
          baseDelay * Math.pow(1.5, item.retries - 1),
          maxDelay
        );
        const errorMsg = formatErrorMessage(error) || '未知错误';
        logWarn(`请求失败，第 ${item.retries} 次重试，${Math.round(delay)}ms 后重试，错误: ${errorMsg}`);
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
 * - On any error: re-queues with exponential backoff delay.
 * - Works with rotation: retry calls acquireCredential() which picks a fresh account.
 * - Retries up to 10 times with short delays (200ms - 2s).
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
