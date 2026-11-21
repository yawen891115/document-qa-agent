type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[threshold] || process.env.VITEST) return;
  const time = new Date().toISOString().slice(11, 23);
  const extra = fields ? ` ${JSON.stringify(fields)}` : "";
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
