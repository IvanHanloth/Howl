import { Command, Flags, Args } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import * as cliProgress from 'cli-progress';
import {
  LanDiscovery,
  LanSender,
  generatePeerId,
  FileMetadata,
  FirewallHelper,
} from '@howl/core';

/**
 * Send command - Send files via LAN or P2P
 */
export default class Send extends Command {
  static description = 'Send a file to another device';

  static examples = [
    '<%= config.bin %> <%= command.id %> ./myfile.mp4',
    '<%= config.bin %> <%= command.id %> ./document.pdf --lan',
    '<%= config.bin %> <%= command.id %> ./video.mkv --mode wan',
  ];

  static flags = {
    lan: Flags.boolean({
      description: 'Force LAN mode (mDNS discovery)',
      default: false,
    }),
    mode: Flags.string({
      description: 'Transfer mode: lan, wan, or auto',
      options: ['lan', 'wan', 'auto'],
      default: 'auto',
    }),
    port: Flags.integer({
      description: 'Port for HTTP server (default: 40000 or next available, can specify any port)',
      default: 0,
    }),
    name: Flags.string({
      description: 'Display name for this device',
      default: require('os').hostname(),
    }),
    downloads: Flags.integer({
      description: 'Maximum number of downloads (0 = unlimited, default = 1, auto-exit after reaching limit)',
      default: 1,
    }),
    'no-verification': Flags.boolean({
      description: 'Disable verification code requirement (allows direct access)',
      default: false,
    }),
    'skip-firewall': Flags.boolean({
      description: 'Skip automatic firewall configuration (Windows only)',
      default: false,
    }),
  };

  static args = {
    file: Args.string({
      description: 'File path to send',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Send);
    const filePath = path.resolve(args.file as string);

    // Validate file exists
    if (!fs.existsSync(filePath)) {
      this.error(chalk.red(`File not found: ${filePath}`));
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      this.error(chalk.red(`Not a file: ${filePath}`));
    }

    // Determine transfer mode
    const mode = flags.lan ? 'lan' : flags.mode;

    this.log(chalk.cyan('🚀 howl - File Transfer\n'));
    this.log(chalk.gray(`File: ${path.basename(filePath)}`));
    this.log(chalk.gray(`Size: ${this.formatBytes(stat.size)}`));
    this.log(chalk.gray(`Mode: ${mode}\n`));

    if (mode === 'lan' || mode === 'auto') {
      await this.sendViaLan(filePath, stat.size, flags.port, flags.name, flags.downloads, flags['no-verification'], flags['skip-firewall']);
    } else {
      this.log(chalk.yellow('WAN mode not yet implemented. Using LAN mode...'));
      await this.sendViaLan(filePath, stat.size, flags.port, flags.name, flags.downloads, flags['no-verification'], flags['skip-firewall']);
    }
  }

  /**
   * Send file via LAN (HTTP + mDNS)
   */
  private async sendViaLan(
    filePath: string,
    fileSize: number,
    requestedPort: number,
    deviceName: string,
    maxDownloads: number,
    noVerification: boolean = false,
    skipFirewall: boolean = false
  ): Promise<void> {
    const peerId = generatePeerId();
    const fileId = path.basename(filePath);

    const fileMetadata: FileMetadata = {
      id: fileId,
      name: path.basename(filePath),
      size: fileSize,
      path: filePath,
    };

    let spinner = ora('Preparing to start...').start();

    // Find available port first
    spinner.text = 'Finding available port...';
    let actualPort: number;
    try {
      actualPort = await FirewallHelper.findAvailablePort(requestedPort || undefined);
      spinner.succeed(`Found available port: ${actualPort}`);
    } catch (error) {
      spinner.fail('Port not available');
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(chalk.red(message));
      return;
    }

    // Windows Firewall handling - check and add rule BEFORE starting server
    if (!skipFirewall && FirewallHelper.isWindows()) {
      spinner = ora('Checking Windows Firewall...').start();

      const firewallEnabled = await FirewallHelper.isFirewallEnabled();
      
      if (firewallEnabled) {
        const portRange = FirewallHelper.getPortRange();
        const isInRange = actualPort >= portRange.start && actualPort <= portRange.end;
        
        // Check if port is already allowed
        const isAllowed = await FirewallHelper.isPortAllowed(actualPort);
        
        if (!isAllowed) {
          spinner.info('Windows Firewall detected - need to add firewall rule');
          
          this.log(chalk.yellow('\n⚠️  Windows Firewall may block connections from other devices.'));
          
          if (isInRange) {
            this.log(chalk.cyan(`🔓 Attempting to add firewall rule for ports ${portRange.start}-${portRange.end}...`));
          } else {
            this.log(chalk.cyan(`🔓 Attempting to add firewall rule for port ${actualPort}...`));
          }
          
          this.log(chalk.gray('   (You will see a UAC permission dialog)\n'));
          
          const result = isInRange 
            ? await FirewallHelper.addRule()
            : await FirewallHelper.addRuleForPort(actualPort);
          
          if (result.success) {
            this.log(chalk.green('✅ ' + result.message + '\n'));
          } else {
            this.log(chalk.yellow('⚠️  ' + result.message));
            
            if (result.message.includes('cancelled')) {
              this.log(chalk.yellow('\n⚠️  Firewall rule not added. Other devices may not be able to connect.'));
              this.log(chalk.cyan('💡 You can manually add the firewall rule later:'));
              this.log(chalk.gray(FirewallHelper.getManualInstructions()));
              this.log(chalk.gray('\nContinuing without firewall rule...\n'));
            } else {
              this.log(chalk.cyan('\n💡 To allow connections from other devices:'));
              this.log(chalk.gray(FirewallHelper.getManualInstructions()));
              this.log(chalk.gray('\nContinuing without firewall rule...\n'));
            }
          }
        } else {
          spinner.succeed(`Firewall rule already exists for port ${actualPort}`);
        }
      } else {
        spinner.succeed('Windows Firewall is disabled');
      }
    }

    // Start HTTP server
    spinner = ora('Starting HTTP server...').start();
    const sender = new LanSender(actualPort);
    const discovery = new LanDiscovery();
    
    // Set download limit
    sender.setMaxDownloads(maxDownloads);
    
    // Set verification mode
    sender.setRequireVerification(!noVerification);

    let progressBar: cliProgress.SingleBar | null = null;
    let progressStarted = false;

    try {
      const serverPort = await sender.start(fileMetadata);
      spinner.succeed(`HTTP server started on 0.0.0.0:${serverPort}`);

      // Get verification code
      const verificationCode = sender.getVerificationCode();

      // Start mDNS advertisement
      spinner.text = 'Advertising on local network...';
      spinner.start();

      discovery.advertise(peerId, deviceName, serverPort, {
        fileName: fileMetadata.name,
        fileSize: fileSize.toString(),
      });

      spinner.succeed('Broadcasting on local network');

      this.log(chalk.green('\n🚀 Ready to receive connections'));
      this.log(chalk.gray('Waiting for receivers...\n'));
      
      // Display verification code prominently (if verification is enabled)
      if (!noVerification) {
        this.log(chalk.cyan('='.repeat(50)));
        this.log(chalk.cyan.bold('\n  🔐 Verification Code: ') + chalk.yellow.bold(verificationCode) + '\n');
        this.log(chalk.cyan('='.repeat(50)));
        
        this.log(chalk.cyan('\n📱 Receivers can connect via:'));
        this.log(chalk.white(`   ⌨️ CLI: Select this device and enter code ${chalk.bold(verificationCode)}`));
        this.log(chalk.white(`   🌐 Web: Open ${chalk.bold.underline(`http://localhost:${serverPort}`)} and enter code`));
      } else {
        this.log(chalk.yellow('\n🔓 Verification is DISABLED - Direct access allowed'));
        this.log(chalk.cyan('\n📱 Receivers can connect via:'));
        this.log(chalk.white(`   ⌨️ CLI: Select this device (no code required)`));
        this.log(chalk.white(`   🌐 Web: Open ${chalk.bold.underline(`http://localhost:${serverPort}/${fileMetadata.name}`)} to download directly`));
      }
      
      // Get local IP addresses
      const networkInterfaces = require('os').networkInterfaces();
      const localIPs: string[] = [];
      for (const [, interfaces] of Object.entries(networkInterfaces)) {
        for (const iface of interfaces as any[]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            localIPs.push(iface.address);
          }
        }
      }
      
      if (localIPs.length > 0) {
        this.log(chalk.gray(`\n📡 Local network URLs:`));
        for (const ip of localIPs) {
          this.log(chalk.gray(`   🌐 http://${ip}:${serverPort}`));
        }
      }
      
      this.log(chalk.gray('\nPress Ctrl+C to stop\n'));

      // Setup progress bar
      progressBar = new cliProgress.SingleBar(
        {
          format:
            'Transfer |' +
            chalk.cyan('{bar}') +
            '| {percentage}% | {value}/{total} MB | Speed: {speed} | ETA: {eta}s',
          barCompleteChar: '\u2588',
          barIncompleteChar: '\u2591',
          hideCursor: true,
        },
        cliProgress.Presets.shades_classic
      );

      // Define cleanup function
      const cleanup = async () => {
        try {
          if (progressStarted && progressBar) {
            progressBar.stop();
          }
          await sender.stop();
          discovery.destroy();
        } catch (err) {
          console.error('[Send] Error during cleanup:', err);
        }
      };

      // Connection event handler
      sender.on('connection', (data: any) => {
        try {
          if (progressStarted && progressBar) {
            progressBar.stop();
            progressStarted = false;
          }
          this.log(chalk.blue(`\n🔗 Incoming connection from ${data.clientIp} (${data.transferType})`));
        } catch (err) {
          console.error('[Send] Error in connection handler:', err);
        }
      });

      // Verification successful handler
      sender.on('verified', (data: any) => {
        try {
          this.log(chalk.green(`✅ Verification successful from ${data.clientIp}`));
        } catch (err) {
          console.error('[Send] Error in verified handler:', err);
        }
      });

      // Verification failed handler
      sender.on('verification-failed', (data: any) => {
        try {
          this.log(chalk.red(`❌ Verification failed from ${data.clientIp} (invalid code)`));
        } catch (err) {
          console.error('[Send] Error in verification-failed handler:', err);
        }
      });

      // Verification required handler
      sender.on('verification-required', (data: any) => {
        try {
          this.log(chalk.yellow(`🔒 Verification required for ${data.clientIp} (${data.transferType})`));
        } catch (err) {
          console.error('[Send] Error in verification-required handler:', err);
        }
      });

      sender.on('progress', (progress: any) => {
        if (!progressStarted) {
          progressBar!.start(Math.ceil(progress.total / 1024 / 1024), 0, {
            speed: '0 MB/s',
          });
          progressStarted = true;
        }

        progressBar!.update(Math.ceil(progress.transferred / 1024 / 1024), {
          speed: this.formatSpeed(progress.speed),
          eta: Math.ceil(progress.eta),
        });
      });

      sender.on('transfer-started', (data: any) => {
        try {
          if (progressStarted && progressBar) {
            progressBar.stop();
            progressStarted = false;
          }
          this.log(chalk.green(`\n📤 Transfer started to ${data.clientIp} (${data.transferType})`));
          this.log(chalk.gray(`   File: ${data.fileName} | Time: ${data.timestamp}`));
        } catch (err) {
          console.error('[Send] Error in transfer-started handler:', err);
        }
      });

      sender.on('transfer-completed', (data: any) => {
        try {
          if (progressStarted && progressBar) {
            progressBar.stop();
            progressStarted = false;
          }
          this.log(chalk.green(`\n✅ Transfer completed! (${data.downloadCount}/${data.maxDownloads})`));
          this.log(chalk.gray(`   Client: ${data.clientIp} | Type: ${data.transferType}`));
        } catch (err) {
          console.error('[Send] Error in transfer-completed handler:', err);
        }
      });

      sender.on('download-limit-reached', (data: any) => {
        try {
          this.log(chalk.yellow(`\n🔔 Download limit reached (${data.currentCount}/${data.maxDownloads}). Shutting down...`));
          sender.stop().then(() => {
            discovery.destroy();
            if (progressStarted && progressBar) {
              progressBar.stop();
            }
            process.exit(0);
          }).catch((err) => {
            console.error('[Send] Error stopping sender:', err);
            process.exit(1);
          });
        } catch (err) {
          console.error('[Send] Error in download-limit-reached handler:', err);
          process.exit(1);
        }
      });

      sender.on('completed', () => {
        if (progressStarted && progressBar) {
          progressBar.stop();
        }
        this.log(chalk.green('\n✅ Transfer completed!'));
      });

      // Keep process alive
      await new Promise<void>((resolve, reject) => {
        const sigintHandler = async () => {
          this.log(chalk.yellow('\n\nShutting down...'));
          try {
            await cleanup();
            resolve();
          } catch (err) {
            reject(err);
          }
        };

        process.on('SIGINT', sigintHandler);

        sender.on('error', async (err: Error) => {
          this.log(chalk.red(`\nError: ${err.message}`));
          console.error('[Send] Sender error:', err);
          try {
            await cleanup();
          } catch (cleanupErr) {
            console.error('[Send] Error during cleanup:', cleanupErr);
          }
          reject(err);
        });
      });
    } catch (error) {
      try {
        if (progressStarted && progressBar) {
          progressBar.stop();
        }
        await sender.stop();
        discovery.destroy();
      } catch (cleanupErr) {
        console.error('[Send] Error during cleanup:', cleanupErr);
      }
      spinner.fail('Failed to start sender');
      throw error;
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  /**
   * Format speed to human-readable string
   */
  private formatSpeed(bytesPerSecond: number): string {
    return `${this.formatBytes(bytesPerSecond)}/s`;
  }
}
