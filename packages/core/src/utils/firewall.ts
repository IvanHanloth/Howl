import { exec } from 'child_process';
import { promisify } from 'util';
import * as sudo from 'sudo-prompt';

const execAsync = promisify(exec);

/**
 * Windows Firewall Helper
 * Manages firewall rules for Howl file transfer
 */
export class FirewallHelper {
  private static readonly RULE_NAME = 'Howl File Transfer';
  private static readonly RULE_NAME_CUSTOM = 'Howl File Transfer - Custom Port';
  private static readonly PORT_RANGE_START = 40000;
  private static readonly PORT_RANGE_END = 40050;
  
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
   * Check if firewall rule exists
   */
  static async ruleExists(): Promise<boolean> {
    if (!this.isWindows()) {
      return false;
    }

    try {
      const { stdout } = await execAsync(
        `netsh advfirewall firewall show rule name="${this.RULE_NAME}"`,
        { windowsHide: true }
      );
      return stdout.includes(this.RULE_NAME);
    } catch {
      return false;
    }
  }

  /**
   * Check if a specific port is allowed in firewall
   */
  static async isPortAllowed(port: number): Promise<boolean> {
    if (!this.isWindows()) {
      return true;
    }

    // Check if port is in default range
    if (port >= this.PORT_RANGE_START && port <= this.PORT_RANGE_END) {
      return await this.ruleExists();
    }

    // Check if custom port rule exists
    try {
      const { stdout } = await execAsync(
        `netsh advfirewall firewall show rule name="${this.RULE_NAME_CUSTOM}"`,
        { windowsHide: true }
      );
      return stdout.includes(this.RULE_NAME_CUSTOM) && stdout.includes(port.toString());
    } catch {
      return false;
    }
  }

  /**
   * Add firewall rule for port range 40000-40050
   * Uses sudo-prompt to trigger UAC elevation dialog
   */
  static async addRule(): Promise<{ success: boolean; message: string }> {
    if (!this.isWindows()) {
      return { success: true, message: 'Not Windows, firewall rule not needed' };
    }

    try {
      // Check if rule already exists
      const exists = await this.ruleExists();
      if (exists) {
        return {
          success: true,
          message: `Firewall rule already exists for ports ${this.PORT_RANGE_START}-${this.PORT_RANGE_END}`,
        };
      }

      // Add new rule for port range using sudo-prompt for UAC elevation
      const command = `netsh advfirewall firewall add rule name="${this.RULE_NAME}" dir=in action=allow protocol=TCP localport=${this.PORT_RANGE_START}-${this.PORT_RANGE_END} enable=yes profile=private,public`;
      
      return new Promise((resolve) => {
        const options = {
          name: 'Howl File Transfer',
        };

        sudo.exec(command, options, (error, _stdout, stderr) => {
          if (error) {
            // Check if user cancelled the UAC prompt
            if (error.message.includes('cancelled') || error.message.includes('user') || stderr?.includes('cancelled')) {
              resolve({
                success: false,
                message: 'User cancelled the permission request',
              });
            } else {
              resolve({
                success: false,
                message: `Failed to add firewall rule: ${error.message}`,
              });
            }
            return;
          }

          resolve({
            success: true,
            message: `Firewall rule added for ports ${this.PORT_RANGE_START}-${this.PORT_RANGE_END}`,
          });
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        message: `Failed to add firewall rule: ${message}`,
      };
    }
  }

  /**
   * Add firewall rule for a specific custom port
   * Uses sudo-prompt to trigger UAC elevation dialog
   */
  static async addRuleForPort(port: number): Promise<{ success: boolean; message: string }> {
    if (!this.isWindows()) {
      return { success: true, message: 'Not Windows, firewall rule not needed' };
    }

    try {
      // Check if port is already in default range
      if (port >= this.PORT_RANGE_START && port <= this.PORT_RANGE_END) {
        return await this.addRule();
      }

      // Check if custom port rule already exists
      const isAllowed = await this.isPortAllowed(port);
      if (isAllowed) {
        return {
          success: true,
          message: `Firewall rule already exists for port ${port}`,
        };
      }

      // Add new rule for custom port using sudo-prompt for UAC elevation
      const command = `netsh advfirewall firewall add rule name="${this.RULE_NAME_CUSTOM} ${port}" dir=in action=allow protocol=TCP localport=${port} enable=yes profile=private,public`;
      
      return new Promise((resolve) => {
        const options = {
          name: 'Howl File Transfer',
        };

        sudo.exec(command, options, (error, _stdout, stderr) => {
          if (error) {
            // Check if user cancelled the UAC prompt
            if (error.message.includes('cancelled') || error.message.includes('user') || stderr?.includes('cancelled')) {
              resolve({
                success: false,
                message: 'User cancelled the permission request',
              });
            } else {
              resolve({
                success: false,
                message: `Failed to add firewall rule: ${error.message}`,
              });
            }
            return;
          }

          resolve({
            success: true,
            message: `Firewall rule added for port ${port}`,
          });
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        message: `Failed to add firewall rule: ${message}`,
      };
    }
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
   * Check if Windows Firewall is enabled
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
      return stdout.toLowerCase().includes('state                                 on');
    } catch {
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
