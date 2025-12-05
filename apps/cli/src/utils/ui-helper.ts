import chalk from 'chalk';

/**
 * CLI UI Helper
 * Provides consistent UI formatting for send and receive commands
 */
export class CliUI {
  /**
   * Display app banner
   */
  static showBanner(mode: 'send' | 'receive'): void {
    const title = mode === 'send' ? '📤 Howl Send' : '📥 Howl Receive';
    const icon = mode === 'send' ? '🚀' : '📡';
    
    console.log();
    console.log(chalk.cyan('╔' + '═'.repeat(58) + '╗'));
    console.log(chalk.cyan('║') + chalk.bold.cyan(`  ${icon}  ${title}`.padEnd(58)) + chalk.cyan('║'));
    console.log(chalk.cyan('╚' + '═'.repeat(58) + '╝'));
    console.log();
  }

  /**
   * Display file information
   */
  static showFileInfo(filename: string, size: number): void {
    console.log(chalk.white('  📄 File: ') + chalk.bold(filename));
    console.log(chalk.white('  💾 Size: ') + chalk.bold(this.formatBytes(size)));
    console.log();
  }

  /**
   * Display server information box
   */
  static showServerInfo(config: {
    mode: 'send' | 'receive';
    port: number;
    verificationCode?: string;
    localIPs: string[];
    filename?: string;
    verificationEnabled?: boolean;
  }): void {
    const { port, verificationCode, localIPs, filename, verificationEnabled = true } = config;
    const primaryIP = localIPs[0] || 'localhost';
    
    console.log(chalk.green('┌' + '─'.repeat(58) + '┐'));
    console.log(chalk.green('│') + chalk.bold.green('  ✓ Server Started'.padEnd(58)) + chalk.green('│'));
    console.log(chalk.green('├' + '─'.repeat(58) + '┤'));
    console.log(chalk.green('│') + '                                                          '.padEnd(58) + chalk.green('│'));
    console.log(chalk.green('│') + chalk.white(`  🌐 Address:  ${chalk.bold.cyan(`http://${primaryIP}:${port}`)}`.padEnd(68)) + chalk.green('│'));
    
    if (verificationEnabled && verificationCode) {
      console.log(chalk.green('│') + chalk.white(`  🔐 Code:     ${chalk.bold.yellow(verificationCode)}`.padEnd(68)) + chalk.green('│'));
    } else if (!verificationEnabled) {
      console.log(chalk.green('│') + chalk.red(`  ⚠️  Security: ${chalk.bold('VERIFICATION DISABLED')}`.padEnd(68)) + chalk.green('│'));
    }
    
    if (filename) {
      console.log(chalk.green('│') + chalk.white(`  📄 File:     ${chalk.bold(filename)}`.padEnd(68)) + chalk.green('│'));
    }
    
    console.log(chalk.green('│') + '                                                          '.padEnd(58) + chalk.green('│'));
    console.log(chalk.green('└' + '─'.repeat(58) + '┘'));
    console.log();

    // Show additional IPs if available
    if (localIPs.length > 1) {
      console.log(chalk.gray('  Alternative addresses:'));
      for (const ip of localIPs.slice(1, 3)) {
        console.log(chalk.gray(`    • http://${ip}:${port}`));
      }
      console.log();
    }
  }

  /**
   * Display connection instructions
   */
  static showConnectionInstructions(mode: 'send' | 'receive'): void {
    if (mode === 'send') {
      console.log(chalk.cyan('  📱 Receivers can connect via:'));
      console.log(chalk.white('     • Use CLI to discover and download'));
      console.log(chalk.white('     • Open web browser and enter verification code'));
      console.log();
    } else {
      console.log(chalk.cyan('  📱 Senders can upload via:'));
      console.log(chalk.white('     • Use CLI to discover and upload'));
      console.log(chalk.white('     • Open web upload page in browser'));
      console.log();
    }
  }

  /**
   * Display device discovery status
   */
  static showDiscoveryBox(config: {
    mode: 'send' | 'receive';
    deviceCount: number;
    devices?: Array<{ name: string; ip: string; port: number; fileName?: string; fileSize?: string }>;
  }): void {
    const { mode, deviceCount, devices = [] } = config;
    const deviceType = mode === 'send' ? 'Receivers' : 'Senders';
    
    console.log(chalk.cyan('╔' + '═'.repeat(58) + '╗'));
    console.log(chalk.cyan('║') + chalk.bold.cyan(`  ✨ Found ${deviceCount} ${deviceType}!`.padEnd(60)) + chalk.cyan('║'));
    console.log(chalk.cyan('╚' + '═'.repeat(58) + '╝'));
    console.log();
    
    if (devices.length > 0) {
      console.log(chalk.white('  Discovered devices:'));
      console.log();
      devices.forEach((device, index) => {
        console.log(chalk.white(`  ${index + 1}. `) + chalk.bold(device.name));
        console.log(chalk.gray(`     📍 ${device.ip}:${device.port}`));
        if (device.fileName) {
          console.log(chalk.gray(`     📄 ${device.fileName} (${device.fileSize || 'Unknown size'})`));
        }
        console.log();
      });
    }
  }

  /**
   * Show waiting status
   */
  static showWaiting(mode: 'send' | 'receive'): void {
    const waitingFor = mode === 'send' ? 'receivers' : 'senders';
    console.log(chalk.gray(`  🔍 Searching for ${waitingFor}...`));
    console.log(chalk.gray(`  💡 Tip: Press Ctrl+C to exit`));
    console.log();
  }

  /**
   * Format bytes to human readable
   */
  static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Show security warning
   */
  static showSecurityWarning(): void {
    console.log();
    console.log(chalk.red('╔' + '═'.repeat(58) + '╗'));
    console.log(chalk.red('║') + chalk.bold.red('  ⚠️  SECURITY WARNING'.padEnd(60)) + chalk.red('║'));
    console.log(chalk.red('╠' + '═'.repeat(58) + '╣'));
    console.log(chalk.red('║') + chalk.yellow('  Verification is DISABLED!'.padEnd(60)) + chalk.red('║'));
    console.log(chalk.red('║') + chalk.yellow('  Anyone on your network can access this file!'.padEnd(60)) + chalk.red('║'));
    console.log(chalk.red('║') + chalk.yellow('  Only use this in trusted networks!'.padEnd(60)) + chalk.red('║'));
    console.log(chalk.red('╚' + '═'.repeat(58) + '╝'));
    console.log();
  }

  /**
   * Show progress status
   */
  static showProgressInfo(message: string, status: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
    const icons = {
      info: 'ℹ️',
      success: '✅',
      error: '❌',
      warning: '⚠️',
    };
    
    const colors = {
      info: chalk.cyan,
      success: chalk.green,
      error: chalk.red,
      warning: chalk.yellow,
    };
    
    console.log(colors[status](`  ${icons[status]}  ${message}`));
  }

  /**
   * Show section divider
   */
  static showDivider(): void {
    console.log(chalk.gray('  ' + '─'.repeat(56)));
  }
}
