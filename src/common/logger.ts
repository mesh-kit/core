/**
 * Dedicated logger utility for mesh-kit
 * Provides styled logs on client and control over log levels
 * without modifying global console methods
 */

// Log levels
export enum LogLevel {
  /** no logging */
  NONE = 0,
  /** only errors */
  ERROR = 1,
  /** errors and warnings */
  WARN = 2,
  /** errors, warnings, and info */
  INFO = 3,
  /** all logs */
  DEBUG = 4,
}

export interface LoggerConfig {
  level: LogLevel;
  prefix: string;
  styling: boolean;
}

const isBrowser =
  typeof window !== "undefined" && typeof window.document !== "undefined";

export class Logger {
  private config: LoggerConfig;

  constructor(config?: Partial<LoggerConfig>) {
    this.config = {
      level: config?.level ?? LogLevel.INFO,
      prefix: config?.prefix ?? "[mesh]",
      styling: config?.styling ?? isBrowser, // Default to styling in browser only
    };
  }

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  info(...args: any[]): void {
    if (this.config.level >= LogLevel.INFO) {
      this.log("log", ...args);
    }
  }

  warn(...args: any[]): void {
    if (this.config.level >= LogLevel.WARN) {
      this.log("warn", ...args);
    }
  }

  error(...args: any[]): void {
    if (this.config.level >= LogLevel.ERROR) {
      this.log("error", ...args);
    }
  }

  debug(...args: any[]): void {
    if (this.config.level >= LogLevel.DEBUG) {
      this.log("debug", ...args);
    }
  }

  private log(
    method: "log" | "warn" | "error" | "debug",
    ...args: any[]
  ): void {
    if (this.config.styling && isBrowser) {
      const styles = {
        prefix:
          "background: #000; color: #FFA07A; padding: 2px 4px; border-radius: 2px;",
        reset: "",
      };

      console[method](
        `%c${this.config.prefix}%c`,
        styles.prefix,
        styles.reset,
        ...args
      );
    } else {
      console[method](this.config.prefix, ...args);
    }
  }
}

export const clientLogger = new Logger({
  level: LogLevel.ERROR,
  styling: true,
});

export const serverLogger = new Logger({
  level: LogLevel.ERROR,
  styling: false,
});

export default isBrowser ? clientLogger : serverLogger;
