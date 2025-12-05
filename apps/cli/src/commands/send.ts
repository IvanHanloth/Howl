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
  DebugLogger,
} from '@howl/core';
import { CliUI } from '../utils/ui-helper';

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
    dev: Flags.boolean({
      description: 'Enable debug logging (shows detailed internal messages)',
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
    
    // Enable debug logging if --dev flag is set
    if (flags.dev) {
      DebugLogger.setDebugMode(true);
    }
    
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

    CliUI.showBanner('send');
    CliUI.showFileInfo(path.basename(filePath), stat.size);

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
      // Pass userSpecified=true only if user explicitly provided a port (not 0)
      const userSpecified = requestedPort > 0;
      actualPort = await FirewallHelper.findAvailablePort(
        requestedPort > 0 ? requestedPort : undefined,
        userSpecified
      );
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

      try {
        // Use the new ensurePortAllowed method
        const result = await FirewallHelper.ensurePortAllowed(actualPort);

        if (result.success) {
          if (result.uacTriggered) {
            spinner.succeed(`Firewall configured: ${result.message}`);
          } else {
            spinner.succeed(result.message);
          }
        } else {
          spinner.fail('Firewall configuration failed');

          if (result.needsManualConfig) {
            this.log(chalk.yellow('\n⚠️  ' + result.message));
            this.log(chalk.cyan('\n💡 To allow connections from other devices, you can manually configure the firewall:'));
            this.log(chalk.gray(FirewallHelper.getManualInstructions()));
            this.log(chalk.yellow('\n⚠️  Continuing without firewall rule. Other devices may not be able to connect.\n'));
          } else {
            this.log(chalk.red('\n❌ ' + result.message));
            this.error('Failed to configure firewall. Use --skip-firewall to bypass.');
          }
        }
      } catch (error) {
        spinner.fail('Firewall check failed');
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.log(chalk.yellow(`\n⚠️  Firewall check error: ${message}`));
        this.log(chalk.yellow('Continuing without firewall configuration...\n'));
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
        role: 'sender',
      });

      spinner.succeed('Broadcasting on local network');

      // Get local IP addresses
      const { getLocalIpAddresses } = require('@howl/core');
      const localIPs = getLocalIpAddresses();
      
      // Show security warning if verification is disabled
      if (!noVerification) {
        CliUI.showServerInfo({
          mode: 'send',
          port: serverPort,
          verificationCode,
          localIPs,
          filename: fileMetadata.name,
          verificationEnabled: true,
        });
      } else {
        CliUI.showSecurityWarning();
        CliUI.showServerInfo({
          mode: 'send',
          port: serverPort,
          localIPs,
          filename: fileMetadata.name,
          verificationEnabled: false,
        });
      }

      CliUI.showConnectionInstructions('send');

      CliUI.showWaiting('send');

      // Start searching for receivers in background
      const receivers: Map<string, any> = new Map();
      let firstReceiverFoundTime: number | null = null;
      let searchTimedOut = false;

      discovery.on('service-up', (service: any) => {
        if (service.txt?.role === 'receiver') {
          receivers.set(service.id, service);
          CliUI.showProgressInfo(`Found: ${service.txt?.name || service.name} (${service.host}:${service.port})`, 'success');
          
          // Mark when first receiver is found
          if (!firstReceiverFoundTime) {
            firstReceiverFoundTime = Date.now();
          }
        }
      });

      discovery.on('service-down', (service: any) => {
        if (service.txt?.role === 'receiver') {
          receivers.delete(service.id);
          CliUI.showProgressInfo(`Receiver left: ${service.txt?.name || service.name}`, 'info');
        }
      });

      // Check if 3 seconds passed since first receiver found
      const checkSearchTimeout = setInterval(() => {
        if (firstReceiverFoundTime && Date.now() - firstReceiverFoundTime >= 3000 && !searchTimedOut) {
          searchTimedOut = true;
          clearInterval(checkSearchTimeout);
          
          // Show selection menu
          this.showReceiverSelectionMenu(receivers, discovery, filePath, sender).catch(err => {
            console.error('[Send] Error in selection menu:', err);
          });
        }
      }, 100);

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
          CliUI.showProgressInfo(`Transfer completed! (${data.downloadCount}/${data.maxDownloads})`, 'success');
          this.log(chalk.gray(`   Client: ${data.clientIp} | Type: ${data.transferType}`));
        } catch (err) {
          console.error('[Send] Error in transfer-completed handler:', err);
        }
      });

      sender.on('download-limit-reached', (data: any) => {
        try {
          CliUI.showProgressInfo(`Download limit reached (${data.currentCount}/${data.maxDownloads}). Shutting down...`, 'warning');
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
   * Show receiver selection menu
   */
  private async showReceiverSelectionMenu(
    receivers: Map<string, any>,
    discovery: LanDiscovery,
    filePath: string,
    sender: LanSender
  ): Promise<void> {
    if (receivers.size === 0) {
      return;
    }

    const { default: prompts } = await import('prompts');
    
    // Show discovered receivers in a nice box
    const devices = Array.from(receivers.values()).map((service: any) => ({
      name: service.txt?.name || service.name,
      ip: service.host,
      port: service.port,
    }));
    
    CliUI.showDiscoveryBox({
      mode: 'send',
      deviceCount: receivers.size,
      devices,
    });
    
    this.log(chalk.gray('You can select a receiver or press Ctrl+C to stay in server mode.\n'));

    let selectedReceiver: any = null;

    while (!selectedReceiver) {
      const receiverArray = Array.from(receivers.values());
      const choices = receiverArray.map((service: any) => ({
        title: `${service.txt?.name || service.name}`,
        description: `${service.host}:${service.port}`,
        value: service,
      }));

      choices.push({
        title: chalk.cyan('🔄 Search again (R)'),
        description: 'Continue searching for more devices',
        value: 'RESEARCH' as any,
      });

      this.log(chalk.cyan('📋 Select a receiver:\n'));

      const response = await prompts({
        type: 'select',
        name: 'receiver',
        message: 'Select a receiver:',
        choices,
      });

      if (!response.receiver) {
        // User cancelled - continue running server
        this.log(chalk.yellow('\nCancelled. Server continues running...\n'));
        return;
      }

      if (response.receiver === 'RESEARCH') {
        this.log(chalk.cyan('\n🔍 Searching for more receivers...\n'));
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      selectedReceiver = response.receiver;
    }

    // User selected a receiver - stop server and connect
    this.log(chalk.cyan('\n🔗 Connecting to receiver...'));
    
    // Stop the sender server
    await sender.stop();
    discovery.destroy();

    // Prompt for verification code
    this.log(chalk.cyan('\n🔐 Verification Required'));
    this.log(chalk.gray('Ask the receiver to provide their verification code.\n'));
    
    const codeResponse = await prompts({
      type: 'text',
      name: 'code',
      message: 'Enter the 6-digit verification code from the receiver:',
      validate: (value: string) => {
        const trimmed = value.trim();
        if (trimmed.length !== 6) {
          return 'Verification code must be 6 digits';
        }
        if (!/^\d{6}$/.test(trimmed)) {
          return 'Verification code must contain only numbers';
        }
        return true;
      },
    });

    if (!codeResponse.code) {
      this.log(chalk.yellow('Cancelled'));
      process.exit(0);
    }

    // Upload file to receiver
    await this.uploadToReceiver(
      selectedReceiver.host,
      selectedReceiver.port,
      filePath,
      codeResponse.code.trim()
    );

    process.exit(0);
  }

  /**
   * Upload file to receiver's HTTP server
   */
  private async uploadToReceiver(
    host: string,
    port: number,
    filePath: string,
    verificationCode: string
  ): Promise<void> {
    const { LanReceiver } = await import('@howl/core');
    const receiver = new LanReceiver();

    const uploadSpinner = ora('Uploading file to receiver...').start();

    const progressBar = new cliProgress.SingleBar(
      {
        format:
          'Upload |' +
          chalk.cyan('{bar}') +
          '| {percentage}% | {value}/{total} MB | Speed: {speed} | ETA: {eta}s',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    let progressStarted = false;

    receiver.on('progress', (progress: any) => {
      if (!progressStarted) {
        uploadSpinner.stop();
        progressBar.start(Math.ceil(progress.total / 1024 / 1024), 0, {
          speed: '0 MB/s',
        });
        progressStarted = true;
      }

      progressBar.update(Math.ceil(progress.transferred / 1024 / 1024), {
        speed: this.formatSpeed(progress.speed),
        eta: Math.ceil(progress.eta),
      });
    });

    try {
      await receiver.upload(host, port, filePath, verificationCode);
      if (progressStarted) {
        progressBar.stop();
      } else {
        uploadSpinner.stop();
      }
      this.log(chalk.green('\n✅ Upload completed!'));
    } catch (error) {
      if (progressStarted) {
        progressBar.stop();
      } else {
        uploadSpinner.fail('Upload failed');
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(chalk.red(`Upload error: ${message}`));
    } finally {
      receiver.destroy();
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
