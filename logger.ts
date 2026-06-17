import winston from "winston";

const { combine, timestamp, errors, splat, json, colorize, printf } = winston.format;

const isProduction = process.env.NODE_ENV === "production";

/** Human-readable format for local development. */
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  errors({ stack: true }),
  splat(),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} ${level}: ${stack ?? message}${rest}`;
  })
);

/** Structured JSON format for production log aggregation. */
const prodFormat = combine(timestamp(), errors({ stack: true }), splat(), json());

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  format: isProduction ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
});

/**
 * Create a child logger that tags every line with a module/context label.
 *
 * @example
 *   const log = createLogger("opensearch");
 *   log.info("connected", { host });
 */
export function createLogger(label: string): winston.Logger {
  return logger.child({ label });
}

export default logger;
