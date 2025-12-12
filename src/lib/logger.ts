import debugModule from "debug";

export interface Logger {
  debug: debugModule.Debugger;
  info: debugModule.Debugger;
  warn: debugModule.Debugger;
  error: debugModule.Debugger;
}

export function createLogger(namespace: string): Logger {
  const base = debugModule(namespace);
  return {
    debug: base,
    info: base.extend("info"),
    warn: base.extend("warn"),
    error: base.extend("error"),
  };
}

/**
 * 打印全局未捕获错误（包含完整堆栈），避免 “Expected a Response object” 这类无堆栈错误难以排查。
 */
export function installGlobalErrorLogger(context: string): void {
  process.on("unhandledRejection", (reason) => {
    const err =
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
    console.error(`[${context}] UnhandledRejection:`, err.stack || err);
  });

  process.on("uncaughtException", (err) => {
    console.error(`[${context}] UncaughtException:`, err.stack || err);
  });
}
