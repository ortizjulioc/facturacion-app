import pino from "pino";
import type { Env } from "./env";

export const createLogger = (env: Env) =>
  pino({
    level: env.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token"],
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });

export type Logger = ReturnType<typeof createLogger>;
