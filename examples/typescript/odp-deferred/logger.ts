type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const normalizeLevel = (value?: string): LogLevel => {
  switch ((value || "").toLowerCase()) {
    case "debug":
      return "debug";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "info":
    default:
      return "info";
  }
};

const logLevel = normalizeLevel(process.env.LOG_LEVEL);
const logFormat = (process.env.LOG_FORMAT || "text").toLowerCase();

const nowIso = (): string => new Date().toISOString();

const normalizeFields = (fields?: LogFields): LogFields | undefined => {
  if (!fields) return undefined;
  const result: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      result[key] = { message: value.message, stack: value.stack };
    } else {
      result[key] = value;
    }
  }
  return result;
};

const jsonReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

const stringifyValue = (value: unknown) => JSON.stringify(value, jsonReplacer);

const formatText = (level: LogLevel, message: string, context?: LogFields, fields?: LogFields) => {
  const merged = { ...context, ...fields };
  const extras = Object.entries(merged)
    .map(([key, value]) => `${key}=${stringifyValue(value)}`)
    .join(" ");
  return `${nowIso()} ${level.toUpperCase()} ${message}${extras ? ` ${extras}` : ""}`;
};

const formatJson = (level: LogLevel, message: string, context?: LogFields, fields?: LogFields) =>
  JSON.stringify(
    {
    ts: nowIso(),
    level,
    message,
    ...context,
    ...fields,
    },
    jsonReplacer,
  );

const emitLog = (level: LogLevel, message: string, context?: LogFields, fields?: LogFields) => {
  if (levelOrder[level] < levelOrder[logLevel]) return;
  const normalizedFields = normalizeFields(fields);
  const line =
    logFormat === "json"
      ? formatJson(level, message, context, normalizedFields)
      : formatText(level, message, context, normalizedFields);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

export const createLogger = (context: LogFields = {}): Logger => ({
  debug: (message, fields) => emitLog("debug", message, context, fields),
  info: (message, fields) => emitLog("info", message, context, fields),
  warn: (message, fields) => emitLog("warn", message, context, fields),
  error: (message, fields) => emitLog("error", message, context, fields),
  child: (fields: LogFields) => createLogger({ ...context, ...fields }),
});
