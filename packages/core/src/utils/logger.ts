/**
 * Debug Logger
 * Provides conditional logging based on debug mode
 */
export class DebugLogger {
  private static debugMode: boolean = false;
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  /**
   * Enable or disable debug mode globally
   */
  static setDebugMode(enabled: boolean): void {
    DebugLogger.debugMode = enabled;
  }

  /**
   * Get current debug mode status
   */
  static isDebugMode(): boolean {
    return DebugLogger.debugMode;
  }

  /**
   * Log debug message (only shown in debug mode)
   */
  debug(...args: any[]): void {
    if (DebugLogger.debugMode) {
      console.log(`[${this.prefix}]`, ...args);
    }
  }

  /**
   * Log info message (always shown)
   */
  info(...args: any[]): void {
    console.log(`[${this.prefix}]`, ...args);
  }

  /**
   * Log warning message (always shown)
   */
  warn(...args: any[]): void {
    console.warn(`[${this.prefix}]`, ...args);
  }

  /**
   * Log error message (always shown)
   */
  error(...args: any[]): void {
    console.error(`[${this.prefix}]`, ...args);
  }
}
