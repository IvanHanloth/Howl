import { exec } from 'child_process';
import { promisify } from 'util';
import * as sudoPrompt from '@vscode/sudo-prompt';

const execAsync = promisify(exec);

/**
 * Windows Firewall Helper
 * Manages firewall rules for Howl file transfer
 * 
 * This helper ensures that:
 * 1. Firewall rules are checked before starting any server
 * 2. UAC prompt is triggered when rules need to be added
 * 3. Ports are properly allowed for LAN access
 */
export class FirewallHelper {
  private static readonly RULE_NAME = 'Howl File Transfer';
  private static readonly RULE_NAME_PREFIX = 'Howl File Transfer - Port';
  private static readonly PORT_RANGE_START = 40000;
  private static readonly PORT_RANGE_END = 40050;
  private static readonly SUDO_OPTIONS = {
    name: 'Howl File Transfer',
    icns: undefined, // Optional: path to application icon
  };
  
  /**
   * Check if running on Windows
   */
  static isWindows(): boolean {
    return process.platform === 'win32';
  }

  /**
   * Check if running as administrator (Windows only)
   */
  static async isAdmin(): Promise<boolean> {
    if (!this.isWindows()) {
      return false;
    }

    try {
      await execAsync('net session', { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute command with sudo/admin privileges using sudo-prompt
   * This will trigger UAC dialog on Windows
   */
  private static execWithSudo(command: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      console.log('[FirewallHelper] Executing command with elevated privileges...');
      console.log('[FirewallHelper] Command:', command);
      
      sudoPrompt.exec(
        command,
        this.SUDO_OPTIONS,
        (error: Error | undefined, stdout: string | Buffer | undefined, stderr: string | Buffer | undefined) => {
          if (error) {
            console.error('[FirewallHelper] Elevated command failed:', error.message);
            reject(error);
          } else {
            console.log('[FirewallHelper] Elevated command succeeded');
            resolve({
              stdout: stdout ? stdout.toString() : '',
              stderr: stderr ? stderr.toString() : '',
            });
          }
        }
      );
    });
  }

  /**
   * Check if firewall rule exists for default port range
   * Uses regular exec (no elevation needed for query operations)
   */
  static async ruleExists(): Promise<boolean> {
    if (!this.isWindows()) {
      return false;
    }

    try {
      console.log(`[FirewallHelper] Checking if rule "${this.RULE_NAME}" exists...`);
      const { stdout } = await execAsync(
        `netsh advfirewall firewall show rule name="${this.RULE_NAME}"`,
        { windowsHide: true }
      );
      const exists = stdout.includes(this.RULE_NAME);
      console.log(`[FirewallHelper] Rule exists: ${exists}`);
      return exists;
    } catch (error) {
      console.log('[FirewallHelper] Rule does not exist or error checking:', error instanceof Error ? error.message : 'unknown');
      return false;
    }
  }

  /**
   * Check if a specific port has a firewall rule
   * This checks for either:
   * 1. The port being in the default range (40000-40050) with the main rule
   * 2. A specific rule for this port
   */
  static async hasRuleForPort(port: number): Promise<boolean> {
    if (!this.isWindows()) {
      return true; // Non-Windows systems don't need firewall rules
    }

    console.log(`[FirewallHelper] Checking if port ${port} is allowed...`);

    // Check if port is in default range and main rule exists
    if (port >= this.PORT_RANGE_START && port <= this.PORT_RANGE_END) {
      const hasMainRule = await this.ruleExists();
      console.log(`[FirewallHelper] Port ${port} in default range, main rule exists: ${hasMainRule}`);
      return hasMainRule;
    }

    // Check for specific port rule
    try {
      const ruleName = `${this.RULE_NAME_PREFIX} ${port}`;
      const { stdout } = await execAsync(
        `netsh advfirewall firewall show rule name="${ruleName}"`,
        { windowsHide: true }
      );
      const exists = stdout.includes(ruleName) && stdout.includes(port.toString());
      console.log(`[FirewallHelper] Specific rule for port ${port} exists: ${exists}`);
      return exists;
    } catch (error) {
      console.log(`[FirewallHelper] No specific rule for port ${port}`);
      return false;
    }
  }

  /**
   * Check if a specific port is allowed in firewall
   * @deprecated Use hasRuleForPort instead
   */
  static async isPortAllowed(port: number): Promise<boolean> {
    return this.hasRuleForPort(port);
  }

  /**
   * Add firewall rule for port range 40000-40050
   * Uses sudo-prompt to trigger UAC elevation dialog
   * This is the main rule that should be added first
   */
  static async addRule(): Promise<{ success: boolean; message: string }> {
    if (!this.isWindows()) {
      return { success: true, message: 'Not Windows, firewall rule not needed' };
    }

    try {
      console.log(`[FirewallHelper] Attempting to add firewall rule for port range ${this.PORT_RANGE_START}-${this.PORT_RANGE_END}...`);
      
      // Check if rule already exists
      const exists = await this.ruleExists();
      if (exists) {
        console.log('[FirewallHelper] Rule already exists');
        return {
          success: true,
          message: `Firewall rule already exists for ports ${this.PORT_RANGE_START}-${this.PORT_RANGE_END}`,
        };
      }

      // Add new rule for port range using sudo-prompt for UAC elevation
      const command = `netsh advfirewall firewall add rule name="${this.RULE_NAME}" dir=in action=allow protocol=TCP localport=${this.PORT_RANGE_START}-${this.PORT_RANGE_END} enable=yes profile=private,public`;
      
      console.log('[FirewallHelper] Triggering UAC prompt...');
      
      try {
        await this.execWithSudo(command);
        
        // Verify rule was actually added
        const nowExists = await this.ruleExists();
        if (!nowExists) {
          throw new Error('Rule was not added successfully');
        }
        
        console.log('[FirewallHelper] Firewall rule added successfully');
        return {
          success: true,
          message: `Firewall rule added for ports ${this.PORT_RANGE_START}-${this.PORT_RANGE_END}`,
        };
      } catch (error: any) {
        // Check if user cancelled the UAC prompt
        const errorMsg = error?.message || '';
        if (errorMsg.includes('cancelled') || errorMsg.includes('User did not grant permission')) {
          console.log('[FirewallHelper] User cancelled UAC prompt');
          return {
            success: false,
            message: 'User cancelled the permission request',
          };
        }
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[FirewallHelper] Failed to add firewall rule:', message);
      return {
        success: false,
        message: `Failed to add firewall rule: ${message}`,
      };
    }
  }

  /**
   * Add firewall rule for a specific custom port (outside default range)
   * Uses sudo-prompt to trigger UAC elevation dialog
   */
  static async addRuleForPort(port: number): Promise<{ success: boolean; message: string }> {
    if (!this.isWindows()) {
      return { success: true, message: 'Not Windows, firewall rule not needed' };
    }

    try {
      console.log(`[FirewallHelper] Attempting to add firewall rule for port ${port}...`);
      
      // Check if port is already in default range
      if (port >= this.PORT_RANGE_START && port <= this.PORT_RANGE_END) {
        console.log(`[FirewallHelper] Port ${port} is in default range, using main rule`);
        return await this.addRule();
      }

      // Check if custom port rule already exists
      const exists = await this.hasRuleForPort(port);
      if (exists) {
        console.log(`[FirewallHelper] Rule already exists for port ${port}`);
        return {
          success: true,
          message: `Firewall rule already exists for port ${port}`,
        };
      }

      // Add new rule for custom port using sudo-prompt for UAC elevation
      const ruleName = `${this.RULE_NAME_PREFIX} ${port}`;
      const command = `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port} enable=yes profile=private,public`;
      
      console.log('[FirewallHelper] Triggering UAC prompt...');
      
      try {
        await this.execWithSudo(command);
        
        // Verify rule was actually added
        const nowExists = await this.hasRuleForPort(port);
        if (!nowExists) {
          throw new Error('Rule was not added successfully');
        }
        
        console.log(`[FirewallHelper] Firewall rule added successfully for port ${port}`);
        return {
          success: true,
          message: `Firewall rule added for port ${port}`,
        };
      } catch (error: any) {
        // Check if user cancelled the UAC prompt
        const errorMsg = error?.message || '';
        if (errorMsg.includes('cancelled') || errorMsg.includes('User did not grant permission')) {
          console.log('[FirewallHelper] User cancelled UAC prompt');
          return {
            success: false,
            message: 'User cancelled the permission request',
          };
        }
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[FirewallHelper] Failed to add firewall rule for port ${port}:`, message);
      return {
        success: false,
        message: `Failed to add firewall rule: ${message}`,
      };
    }
  }

  /**
   * Ensure a port is allowed in the firewall
   * This is the main method to call before starting a server
   * It will:
   * 1. Check if Windows Firewall is enabled
   * 2. Check if the port has a rule
   * 3. Add a rule if needed (triggers UAC)
   * 4. Return the result
   * 
   * @param port The port to ensure is allowed
   * @returns Object with success status, whether UAC was triggered, and message
   */
  static async ensurePortAllowed(port: number): Promise<{
    success: boolean;
    uacTriggered: boolean;
    message: string;
    needsManualConfig: boolean;
  }> {
    if (!this.isWindows()) {
      console.log('[FirewallHelper] Not Windows, skipping firewall configuration');
      return {
        success: true,
        uacTriggered: false,
        message: 'Not Windows, firewall configuration not needed',
        needsManualConfig: false,
      };
    }

    console.log(`[FirewallHelper] Ensuring port ${port} is allowed in firewall...`);

    // Check if Windows Firewall is enabled
    const firewallEnabled = await this.isFirewallEnabled();
    if (!firewallEnabled) {
      console.log('[FirewallHelper] Windows Firewall is disabled');
      return {
        success: true,
        uacTriggered: false,
        message: 'Windows Firewall is disabled, no configuration needed',
        needsManualConfig: false,
      };
    }

    console.log('[FirewallHelper] Windows Firewall is enabled, checking rules...');

    // Check if port already has a rule
    const hasRule = await this.hasRuleForPort(port);
    if (hasRule) {
      console.log(`[FirewallHelper] Port ${port} already has a firewall rule`);
      return {
        success: true,
        uacTriggered: false,
        message: `Port ${port} is already allowed in firewall`,
        needsManualConfig: false,
      };
    }

    console.log(`[FirewallHelper] Port ${port} does not have a firewall rule, adding...`);

    // Add rule (will trigger UAC)
    const addResult = (port >= this.PORT_RANGE_START && port <= this.PORT_RANGE_END)
      ? await this.addRule()
      : await this.addRuleForPort(port);

    if (addResult.success) {
      return {
        success: true,
        uacTriggered: true,
        message: addResult.message,
        needsManualConfig: false,
      };
    }

    // If adding rule failed, check if it was cancelled by user
    if (addResult.message.includes('cancelled')) {
      console.log('[FirewallHelper] User cancelled UAC prompt');
      return {
        success: false,
        uacTriggered: true,
        message: 'User cancelled firewall configuration. Other devices may not be able to connect.',
        needsManualConfig: true,
      };
    }

    // Other error
    console.error('[FirewallHelper] Failed to add firewall rule:', addResult.message);
    return {
      success: false,
      uacTriggered: true,
      message: `Failed to configure firewall: ${addResult.message}`,
      needsManualConfig: true,
    };
  }

  /**
   * Remove firewall rule
   */
  static async removeRule(): Promise<{ success: boolean; message: string }> {
    if (!this.isWindows()) {
      return { success: true, message: 'Not Windows, no rule to remove' };
    }

    try {
      const exists = await this.ruleExists();
      if (!exists) {
        return { success: true, message: 'Firewall rule does not exist' };
      }

      const command = `netsh advfirewall firewall delete rule name="${this.RULE_NAME}"`;
      await execAsync(command, { windowsHide: true });
      
      return {
        success: true,
        message: 'Firewall rule removed',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        message: `Failed to remove firewall rule: ${message}`,
      };
    }
  }

  /**
   * Get instructions for manually adding firewall rule
   */
  static getManualInstructions(): string {
    if (!this.isWindows()) {
      return '';
    }

    return `
To manually add a firewall rule for Howl:

1. Open PowerShell as Administrator
2. Run this command:
   netsh advfirewall firewall add rule name="${this.RULE_NAME}" dir=in action=allow protocol=TCP localport=${this.PORT_RANGE_START}-${this.PORT_RANGE_END} enable=yes profile=private,public

Or use Windows Defender Firewall with Advanced Security:
1. Press Win+R, type 'wf.msc', press Enter
2. Click "Inbound Rules" > "New Rule"
3. Select "Port" > Next
4. TCP, Specific local ports: ${this.PORT_RANGE_START}-${this.PORT_RANGE_END} > Next
5. Allow the connection > Next
6. Check Private and Public > Next
7. Name: ${this.RULE_NAME} > Finish
`;
  }

  /**
   * Find an available port in the range 40000-40050, or continue beyond if all occupied
   * Returns the specified port if available, otherwise searches the range and beyond
   */
  static async findAvailablePort(preferredPort?: number): Promise<number> {
    const net = require('net');
    
    const isPortAvailable = (port: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const server = net.createServer();
        
        server.once('error', () => {
          resolve(false);
        });
        
        server.once('listening', () => {
          server.close();
          resolve(true);
        });
        
        server.listen(port);
      });
    };

    // If preferred port specified, try it first (can be any port)
    if (preferredPort && preferredPort > 0) {
      if (await isPortAvailable(preferredPort)) {
        return preferredPort;
      }
      throw new Error(`Specified port ${preferredPort} is not available`);
    }

    // Try default port 40000 first
    if (await isPortAvailable(this.PORT_RANGE_START)) {
      return this.PORT_RANGE_START;
    }

    // Search for available port in range 40000-40050
    for (let port = this.PORT_RANGE_START + 1; port <= this.PORT_RANGE_END; port++) {
      if (await isPortAvailable(port)) {
        return port;
      }
    }

    // If no port in range is available, continue searching beyond
    console.warn(`[FirewallHelper] No available port in range ${this.PORT_RANGE_START}-${this.PORT_RANGE_END}, searching beyond...`);
    for (let port = this.PORT_RANGE_END + 1; port <= 65535; port++) {
      if (await isPortAvailable(port)) {
        console.warn(`[FirewallHelper] Using port ${port} outside default range`);
        return port;
      }
    }

    // This should rarely happen
    throw new Error('No available port found');
  }

  /**
   * Get the port range used by Howl
   */
  static getPortRange(): { start: number; end: number } {
    return {
      start: this.PORT_RANGE_START,
      end: this.PORT_RANGE_END,
    };
  }

  /**
   * Parse firewall state from netsh output using regex
   * Language-independent: works with English, Chinese, Spanish, French, etc.
   * 
   * @param output - Raw output from "netsh advfirewall show allprofiles state"
   * @returns true if firewall is enabled in any profile
   */
  private static parseFirewallState(output: string): boolean {
    // Regex patterns for different languages:
    // - English: "State : On" or "State: On"
    // - Chinese: "状态                                  启用" (many spaces) or "状态 : 启用"
    // - Spanish: "Estado : Activado"
    // - French: "Etat : Activé"
    
    // Match state keyword followed by any separator and enabled keyword
    const patterns = [
      // Match "State" (English) or "状态" (Chinese) or other language variants
      // followed by optional colon or spaces, then enabled state
      /(?:State|状态|Estado|Etat|Stato|Stato)\s+(?:[:,：])?\s*(On|启用|已启用|Activado|Activé|Abilitato|Ingeschakeld|Włączony)/i,
      // For Chinese: match "状态" followed by many spaces then "启用"
      /状态\s{2,}启用/,
    ];
    
    return patterns.some(regex => regex.test(output));
  }

  /**
   * Check if Windows Firewall is enabled
   * Language-independent parsing using regex patterns
   * Works with Windows in any language
   */
  static async isFirewallEnabled(): Promise<boolean> {
    if (!this.isWindows()) {
      return false;
    }

    try {
      const { stdout } = await execAsync(
        'netsh advfirewall show allprofiles state',
        { windowsHide: true }
      );
      
      // Use regex parsing instead of substring/text matching
      const isEnabled = this.parseFirewallState(stdout);
      console.log(`[FirewallHelper] Firewall enabled: ${isEnabled}`);
      return isEnabled;
    } catch (error) {
      console.error('[FirewallHelper] Failed to check firewall status:', error instanceof Error ? error.message : 'unknown');
      return false;
    }
  }

  /**
   * Test if port is accessible from external machine
   * This creates a simple HTTP server and tests connectivity
   */
  static async testPortAccessibility(_port: number, _timeout: number = 5000): Promise<boolean> {
    // This is a placeholder - actual implementation would require
    // creating a test server and attempting connection
    return true;
  }
}
