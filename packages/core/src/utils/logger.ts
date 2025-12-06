/**
 * Log Level Enum
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

/**
 * Global Logger Configuration
 */
class LoggerConfig {
  private static instance: LoggerConfig;
  private level: LogLevel = LogLevel.INFO;
  private debugMode: boolean = false;

  private constructor() {}

  static getInstance(): LoggerConfig {
    if (!LoggerConfig.instance) {
      LoggerConfig.instance = new LoggerConfig();
    }
    return LoggerConfig.instance;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    this.level = enabled ? LogLevel.DEBUG : LogLevel.INFO;
  }

  isDebugMode(): boolean {
    return this.debugMode;
  }
}

/**
 * Debug Logger
 * Provides conditional logging based on debug mode and log level
 */
export class DebugLogger {
  private prefix: string;
  private static config = LoggerConfig.getInstance();

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  /**
   * Enable or disable debug mode globally
   */
  static setDebugMode(enabled: boolean): void {
    DebugLogger.config.setDebugMode(enabled);
  }

  /**
   * Get current debug mode status
   */
  static isDebugMode(): boolean {
    return DebugLogger.config.isDebugMode();
  }

  /**
   * Set global log level
   */
  static setLogLevel(level: LogLevel): void {
    DebugLogger.config.setLevel(level);
  }

  /**
   * Get current log level
   */
  static getLogLevel(): LogLevel {
    return DebugLogger.config.getLevel();
  }

  /**
   * Log debug message (only shown in debug mode)
   */
  debug(...args: any[]): void {
    if (DebugLogger.config.getLevel() <= LogLevel.DEBUG) {
      console.log(`[${this.prefix}]`, ...args);
    }
  }

  /**
   * Log info message (shown unless silent)
   */
  info(...args: any[]): void {
    if (DebugLogger.config.getLevel() <= LogLevel.INFO) {
      console.log(`[${this.prefix}]`, ...args);
    }
  }

  /**
   * Log warning message (shown unless silent)
   */
  warn(...args: any[]): void {
    if (DebugLogger.config.getLevel() <= LogLevel.WARN) {
      console.warn(`[${this.prefix}]`, ...args);
    }
  }

  /**
   * Log error message (always shown unless silent)
   */
  error(...args: any[]): void {
    if (DebugLogger.config.getLevel() <= LogLevel.ERROR) {
      console.error(`[${this.prefix}]`, ...args);
    }
  }

  /**
   * Log message without prefix (for formatted output)
   */
  raw(...args: any[]): void {
    if (DebugLogger.config.getLevel() <= LogLevel.INFO) {
      console.log(...args);
    }
  }
}
