/**
 * Verification Manager
 * Handles verification code generation and session management
 */
export class VerificationManager {
  private verificationCode: string;
  private verifiedSessions: Set<string> = new Set();

  constructor() {
    this.verificationCode = this.generateCode();
  }

  /**
   * Generate a 6-digit verification code
   */
  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Get the current verification code
   */
  getCode(): string {
    return this.verificationCode;
  }

  /**
   * Regenerate verification code
   */
  regenerateCode(): string {
    this.verificationCode = this.generateCode();
    return this.verificationCode;
  }

  /**
   * Add a verified session token
   */
  addSession(token: string): void {
    this.verifiedSessions.add(token);
  }

  /**
   * Check if a session token is verified
   */
  isSessionVerified(token?: string): boolean {
    if (!token) return false;
    return this.verifiedSessions.has(token);
  }

  /**
   * Generate a session token
   */
  generateSessionToken(): string {
    return Math.random().toString(36).substring(2);
  }

  /**
   * Verify a code and generate session token if valid
   */
  verifyAndCreateSession(code: string): { valid: boolean; sessionToken?: string } {
    const trimmedCode = code?.trim();
    if (trimmedCode === this.verificationCode) {
      const sessionToken = this.generateSessionToken();
      this.addSession(sessionToken);
      return { valid: true, sessionToken };
    }
    return { valid: false };
  }

  /**
   * Clear all verified sessions
   */
  clearSessions(): void {
    this.verifiedSessions.clear();
  }

  /**
   * Get the number of verified sessions
   */
  getSessionCount(): number {
    return this.verifiedSessions.size;
  }
}
