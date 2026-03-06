import { EventEmitter } from 'events';

export interface LogEntry {
  ts: number;        // timestamp ms
  level: 'debug' | 'info' | 'warn' | 'error' | 'req';
  msg: string;
  meta?: Record<string, unknown>;
}

const MAX_BUFFER = 200;
const buffer: LogEntry[] = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

function push(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  emitter.emit('log', entry);
}

export function logDebug(msg: string, meta?: Record<string, unknown>): void {
  push({ ts: Date.now(), level: 'debug', msg, meta });
}

export function logInfo(msg: string, meta?: Record<string, unknown>): void {
  push({ ts: Date.now(), level: 'info', msg, meta });
}

export function logWarn(msg: string, meta?: Record<string, unknown>): void {
  push({ ts: Date.now(), level: 'warn', msg, meta });
}

export function logError(msg: string, meta?: Record<string, unknown>): void {
  push({ ts: Date.now(), level: 'error', msg, meta });
}

export function logReq(msg: string, meta?: Record<string, unknown>): void {
  push({ ts: Date.now(), level: 'req', msg, meta });
}

export function formatErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.toString();
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function getRecentLogs(): LogEntry[] {
  return [...buffer];
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  emitter.on('log', listener);
  return () => emitter.off('log', listener);
}
