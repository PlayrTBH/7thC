import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type CapturedLog = {
  id: number;
  level: LogLevel;
  message: string;
  createdAt: string;
};

const maxLogs = 500;
const logs: CapturedLog[] = [];
let nextLogId = 1;
let installed = false;

const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

export function installConsoleCapture() {
  if (installed) return;
  installed = true;

  console.debug = (...args: unknown[]) => {
    captureLog('debug', args);
    originalConsole.debug(...args);
  };
  console.info = (...args: unknown[]) => {
    captureLog('info', args);
    originalConsole.info(...args);
  };
  console.log = (...args: unknown[]) => {
    captureLog('info', args);
    originalConsole.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    captureLog('warn', args);
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    captureLog('error', args);
    originalConsole.error(...args);
  };
}

export function getRecentLogs(limit = 200) {
  return logs.slice(-Math.max(1, Math.min(limit, maxLogs)));
}

export function clearLogs() {
  logs.length = 0;
}

function captureLog(level: LogLevel, args: unknown[]) {
  logs.push({
    id: nextLogId++,
    level,
    message: args.map(formatLogValue).join(' '),
    createdAt: new Date().toISOString()
  });

  if (logs.length > maxLogs) {
    logs.splice(0, logs.length - maxLogs);
  }
}

function formatLogValue(value: unknown) {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  return inspect(value, { depth: 4, colors: false, compact: false });
}

installConsoleCapture();
