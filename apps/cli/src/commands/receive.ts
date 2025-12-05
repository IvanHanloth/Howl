import { Command, Flags, Args } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import * as cliProgress from 'cli-progress';
import {
  LanDiscovery,
  LanReceiver,
  ServiceInfo,
  TransferProgress,
  FirewallHelper,
  DebugLogger,
} from '@howl/core';
import { CliUI } from '../utils/ui-helper';

/**
 * Receive command - Receive files from another device
 */
export default class Receive extends Command {
  static description = 'Receive a file from another device';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output ./downloads',
    '<%= config.bin %> <%= command.id %> 839210',
    '<%= config.bin %> <%= command.id %> --lan-only',
    '<%= config.bin %> <%= command.id %> --port 8080 --uploads 5',
  ];

  static flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output directory',
      default: './downloads',
    }),
    'lan-only': Flags.boolean({
      description: 'Only use mDNS discovery (disable HTTP upload server)',
      default: false,
    }),
    port: Flags.integer({
      description: 'Port for HTTP server (default: 40001 or next available)',
      default: 0,
    }),
    uploads: Flags.integer({
      description: 'Maximum number of uploads (0 = unlimited, default = 1)',
      default: 1,
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
    code: Args.string({
      description: 'Room code for P2P connection (6 digits)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Receive);
    
    // Enable debug logging if --dev flag is set
    if (flags.dev) {
      DebugLogger.setDebugMode(true);
    }
    
    const outputDir = path.resolve(flags.output);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    CliUI.showBanner('receive');

    // If room code provided, use WAN mode (P2P via signaling server)
    if (args.code) {
      await this.receiveViaWan(args.code as string, outputDir);
      return;
    }

    // Default: Hybrid mode (HTTP server + mDNS discovery)
    // Unless --lan-only flag is set
    if (flags['lan-only']) {
      await this.receiveViaLan(outputDir);
    } else {
      await this.startHybridMode(outputDir, flags.port, flags.uploads, flags['skip-firewall']);
    }
  }

  /**
   * Receive file via LAN (discover senders)
   */
  private async receiveViaLan(outputDir: string): Promise<void> {
    const spinner = ora('Discovering senders on local network...').start();
    const discovery = new LanDiscovery();

    const services: Map<string, ServiceInfo> = new Map();
    let selectionTimeout: NodeJS.Timeout | null = null;
    let showSelectionMenu = false;

    discovery.on('service-up', (service: ServiceInfo) => {
      services.set(service.id, service);
      if (showSelectionMenu) {
        spinner.text = `Found ${services.size} sender(s). Waiting for more...`;
      }
    });

    discovery.on('service-down', (service: ServiceInfo) => {
      services.delete(service.id);
      if (services.size > 0) {
        if (showSelectionMenu) {
          spinner.text = `Found ${services.size} sender(s). Waiting for more...`;
        }
      } else {
        if (showSelectionMenu) {
          spinner.text = 'Discovering senders on local network...';
        }
      }
    });

    discovery.startDiscovery();

    this.log(chalk.gray('\nListening for senders...\n'));

    // Wait for at least one service to be found, then auto-show menu after a delay
    await new Promise<void>((resolve) => {
      const autoShowMenu = () => {
        if (services.size > 0) {
          clearTimeout(selectionTimeout!);
          showSelectionMenu = true;
          spinner.stop();
          resolve();
        } else {
          // Check again in 3 seconds
          selectionTimeout = setTimeout(autoShowMenu, 3000);
        }
      };

      // Start checking after initial discovery period
      selectionTimeout = setTimeout(autoShowMenu, 2000);

      // Also handle Ctrl+C to exit cleanly
      process.once('SIGINT', () => {
        if (selectionTimeout) clearTimeout(selectionTimeout);
        spinner.stop();
        this.log(chalk.yellow('\nReceiver cancelled'));
        discovery.destroy();
        process.exit(0);
      });
    });

    if (services.size === 0) {
      this.log(chalk.yellow('No senders found on local network.'));
      this.log(chalk.gray('Make sure the sender is running and on the same network.'));
      discovery.destroy();
      process.exit(0);
    }

    // Show selection menu with re-search capability
    await this.showSelectionMenuWithResearch(discovery, services, outputDir);
  }

  /**
   * Show sender selection menu
   */
  private async showSenderSelectionMenu(
    senders: Map<string, ServiceInfo>,
    discovery: LanDiscovery,
    receiver: LanReceiver,
    outputDir: string
  ): Promise<void> {
    if (senders.size === 0) {
      return;
    }

    const { default: prompts } = await import('prompts');
    
    // Show discovered senders in a nice box
    const devices = Array.from(senders.values()).map((service: ServiceInfo) => ({
      name: service.txt?.name || service.name,
      ip: service.host,
      port: service.port,
      fileName: service.txt?.fileName,
      fileSize: this.formatBytes(parseInt(service.txt?.fileSize || '0', 10)),
    }));
    
    CliUI.showDiscoveryBox({
      mode: 'receive',
      deviceCount: senders.size,
      devices,
    });
    
    this.log(chalk.gray('You can select a sender or press Ctrl+C to stay in server mode.\n'));

    let selectedSender: ServiceInfo | null = null;

    while (!selectedSender) {
      const senderArray = Array.from(senders.values());
      const choices = senderArray.map((service: ServiceInfo) => ({
        title: `${service.txt?.name || service.name} - ${service.txt?.fileName || 'Unknown file'}`,
        description: `${service.host}:${service.port} (${this.formatBytes(
          parseInt(service.txt?.fileSize || '0', 10)
        )})`,
        value: service,
      }));

      choices.push({
        title: chalk.cyan('🔄 Search again (R)'),
        description: 'Continue searching for more devices',
        value: 'RESEARCH' as any,
      });

      this.log(chalk.cyan('📋 Select a sender:\n'));

      const response = await prompts({
        type: 'select',
        name: 'sender',
        message: 'Select a sender:',
        choices,
      });

      if (!response.sender) {
        // User cancelled - continue running server
        this.log(chalk.yellow('\nCancelled. Server continues running...\n'));
        return;
      }

      if (response.sender === 'RESEARCH') {
        this.log(chalk.cyan('\n🔍 Searching for more senders...\n'));
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      selectedSender = response.sender as ServiceInfo;
    }

    // User selected a sender - stop server and connect
    this.log(chalk.cyan('\n🔗 Connecting to sender...'));
    
    // Stop the receiver server
    await receiver.stopServer();
    discovery.destroy();

    // Prompt for verification code
    this.log(chalk.cyan('\n🔐 Verification Required'));
    const codeResponse = await prompts({
      type: 'text',
      name: 'code',
      message: 'Enter the 6-digit verification code from the sender:',
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

    // Verify and download
    const verificationSpinner = ora('Verifying code...').start();
    const downloadReceiver = new LanReceiver();
    
    try {
      const verified = await downloadReceiver.verify(
        selectedSender.host,
        selectedSender.port,
        codeResponse.code.trim()
      );

      if (!verified) {
        verificationSpinner.fail('Invalid verification code');
        this.log(chalk.red('Please check the code and try again.'));
        process.exit(1);
      }

      verificationSpinner.succeed('Verification successful');
    } catch (error) {
      verificationSpinner.fail('Verification failed');
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(chalk.red(`Verification error: ${message}`));
    }

    // Download file
    await this.downloadFileWithReceiver(
      downloadReceiver,
      selectedSender.host,
      selectedSender.port,
      selectedSender.txt?.fileName || 'download',
      outputDir
    );

    process.exit(0);
  }

  /**
   * Show selection menu with ability to re-search (press R)
   */
  private async showSelectionMenuWithResearch(
    discovery: LanDiscovery,
    services: Map<string, ServiceInfo>,
    outputDir: string
  ): Promise<void> {
    const showMenu = async (): Promise<ServiceInfo | 'RESEARCH' | null> => {
      this.log(chalk.green(`\n�?Found ${services.size} sender(s)\n`));

      // Let user select a sender
      const serviceArray = Array.from(services.values());
      const choices = serviceArray.map(service => ({
        title: `${service.txt?.name || service.name} - ${service.txt?.fileName || 'Unknown file'}`,
        description: `${service.host}:${service.port} (${this.formatBytes(
          parseInt(service.txt?.fileSize || '0', 10)
        )})`,
        value: service,
      }));

      // Add a special "Search again" option at the end
      choices.push({
        title: chalk.cyan('🔍 Search for more senders (5 seconds)'),
        description: 'Continue searching for additional devices',
        value: 'RESEARCH' as any,
      });

      this.log(chalk.cyan('📋 Instructions:'));
      this.log(chalk.gray('  Use ↑ and ↓ arrow keys to move'));
      this.log(chalk.gray('  Press Enter to select'));
      this.log(chalk.gray('  Select "Search for more senders" to continue searching'));
      this.log(chalk.gray('  Press Ctrl+C to cancel\n'));

      const response = await prompts({
        type: 'select',
        name: 'service',
        message: 'Select a sender:',
        choices,
      });

      return response.service || null;
    };

    // Keep track of known service IDs for smart re-search
    let selectedService: ServiceInfo | null = null;
    let knownServiceIds = new Set(services.keys());

    while (!selectedService) {
      const result = await showMenu();

      // Check if user wants to research
      if (result === 'RESEARCH') {
        // Re-search: if devices exist, search for 5 seconds; if no devices, search until found
        if (services.size > 0) {
          this.log(chalk.cyan('\n🔍 Searching for 5 seconds...\n'));
        } else {
          this.log(chalk.cyan('\n🔍 No devices available. Searching until a device is found...\n'));
        }
        
        await this.researchForSenders(services, knownServiceIds);
        
        // Update known service IDs after research
        knownServiceIds = new Set(services.keys());
        continue;
      }

      if (result) {
        selectedService = result as ServiceInfo;
        break;
      }

      // User cancelled (pressed Ctrl+C or ESC)
      this.log(chalk.yellow('\nNo sender selected.\n'));

      const researchResponse = await prompts({
        type: 'confirm',
        name: 'research',
        message: 'Search for more senders?',
        initial: true,
      });

      if (!researchResponse.research) {
        this.log(chalk.yellow('Cancelled'));
        discovery.destroy();
        process.exit(0);
      }

      // Re-search: if devices exist, search for 5 seconds; if no devices, search until found
      if (services.size > 0) {
        this.log(chalk.cyan('\n🔍 Searching for 5 seconds...\n'));
      } else {
        this.log(chalk.cyan('\n🔍 No devices available. Searching until a device is found...\n'));
      }
      
      await this.researchForSenders(services, knownServiceIds);
      
      // Update known service IDs after research
      knownServiceIds = new Set(services.keys());
    }

    // Stop discovery before downloading
    discovery.stopDiscovery();

    // Prompt for verification code
    this.log(chalk.cyan('\n🔐 Verification Required'));
    const codeResponse = await prompts({
      type: 'text',
      name: 'code',
      message: 'Enter the 6-digit verification code from the sender:',
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
      discovery.destroy();
      process.exit(0);
    }

    // Verify the code
    const verificationSpinner = ora('Verifying code...').start();
    const receiver = new LanReceiver();
    
    try {
      const verified = await receiver.verify(
        selectedService.host,
        selectedService.port,
        codeResponse.code.trim()
      );

      if (!verified) {
        verificationSpinner.fail('Invalid verification code');
        this.log(chalk.red('Please check the code and try again.'));
        discovery.destroy();
        process.exit(1);
      }

      verificationSpinner.succeed('Verification successful');
    } catch (error) {
      verificationSpinner.fail('Verification failed');
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(chalk.red(`Verification error: ${message}`));
    }

    // Download file
    await this.downloadFileWithReceiver(
      receiver,
      selectedService.host,
      selectedService.port,
      selectedService.txt?.fileName || 'download',
      outputDir
    );

    discovery.destroy();
  }

  /**
   * Re-search for senders - continues until at least one device is found
   * If devices exist, searches for the specified duration (default 5 seconds)
   * If no devices exist, continues searching indefinitely until at least one is found
   */
  private async researchForSenders(
    services: Map<string, ServiceInfo>,
    knownServiceIds: Set<string>,
    duration: number = 5000
  ): Promise<void> {
    const startTime = Date.now();
    const hasInitialServices = services.size > 0;
    
    const progressBar = new cliProgress.SingleBar(
      {
        format: hasInitialServices 
          ? 'Searching |{bar}| {percentage}% | {value}s/{total}s'
          : 'Searching for devices... ({value}s elapsed)',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    progressBar.start(hasInitialServices ? Math.floor(duration / 1000) : 0, 0);

    return new Promise<void>((resolve) => {
      const updateInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const seconds = Math.floor(elapsed / 1000);
        
        if (hasInitialServices) {
          progressBar.update(Math.min(seconds, Math.floor(duration / 1000)));
        } else {
          progressBar.update(seconds);
        }

        // Check if all known senders have left
        let hasKnownSenders = false;
        for (const id of knownServiceIds) {
          if (services.has(id)) {
            hasKnownSenders = true;
            break;
          }
        }

        // If no known senders exist and time hasn't expired, update the tracking
        // so we can find new senders
        if (!hasKnownSenders && services.size > 0) {
          knownServiceIds.clear();
          for (const id of services.keys()) {
            knownServiceIds.add(id);
          }
        }

        // Stop conditions:
        // 1. If we had initial services and time limit reached
        // 2. If we had no initial services and now we found at least one
        if ((hasInitialServices && elapsed >= duration) || 
            (!hasInitialServices && services.size > 0)) {
          clearInterval(updateInterval);
          progressBar.stop();
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Receive file via WAN (P2P)
   */
  private async receiveViaWan(_code: string, _outputDir: string): Promise<void> {
    this.log(chalk.yellow('WAN mode not yet implemented'));
    this.log(chalk.gray('Please use LAN mode for now (run without a code)'));
  }

  /**
   * Download file from HTTP server with an existing receiver instance
   */
  private async downloadFileWithReceiver(
    receiver: LanReceiver,
    host: string,
    port: number,
    fileName: string,
    outputDir: string
  ): Promise<void> {
    const outputPath = path.join(outputDir, fileName);

    this.log(chalk.gray(`\nDownloading to: ${outputPath}\n`));

    const progressBar = new cliProgress.SingleBar(
      {
        format:
          'Download |' +
          chalk.cyan('{bar}') +
          '| {percentage}% | {value}/{total} MB | Speed: {speed} | ETA: {eta}s',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    let progressStarted = false;

    receiver.on('progress', (progress: TransferProgress) => {
      if (!progressStarted) {
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
      await receiver.download(host, port, fileName, outputPath);
      if (progressStarted) {
        progressBar.stop();
      }
      this.log(chalk.green('\n�?Download completed!'));
      this.log(chalk.gray(`Saved to: ${outputPath}`));
    } catch (error) {
      if (progressStarted) {
        progressBar.stop();
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(chalk.red(`\nDownload failed: ${message}`));
    } finally {
      receiver.destroy();
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    return CliUI.formatBytes(bytes);
  }

  /**
   * Format speed to human-readable string
   */
  private formatSpeed(bytesPerSecond: number): string {
    return `${this.formatBytes(bytesPerSecond)}/s`;
  }

  /**
   * Start HTTP server to receive file uploads
   */
  /**
   * Start hybrid mode: HTTP server + mDNS discovery
   */
  private async startHybridMode(
    outputDir: string,
    requestedPort: number,
    maxUploads: number,
    skipFirewall: boolean = false
  ): Promise<void> {
    CliUI.showProgressInfo('Starting hybrid mode (HTTP + mDNS)...', 'info');
    console.log();

    // Start HTTP server first
    const receiver = await this.setupHttpServer(outputDir, requestedPort, maxUploads, skipFirewall);
    if (!receiver) {
      return; // Error already handled
    }

    const serverPort = receiver.getPort();
    const { generatePeerId } = require('@howl/core');
    const peerId = generatePeerId();
    const deviceName = require('os').hostname();

    // Start mDNS discovery in background
    console.log();
    CliUI.showProgressInfo('Starting mDNS discovery and advertisement...', 'info');
    console.log();
    const discovery = new LanDiscovery();
    const senders: Map<string, ServiceInfo> = new Map();

    // Advertise this receiver so senders can find it
    discovery.advertise(peerId, deviceName, serverPort, {
      role: 'receiver',
    });
    CliUI.showProgressInfo(`Broadcasting as receiver on port ${serverPort}`, 'success');

    discovery.on('service-up', (service: ServiceInfo) => {
      // Only show senders (role = sender)
      if (service.txt?.role === 'sender') {
        senders.set(service.id, service);
        CliUI.showProgressInfo(
          `Sender: ${service.name} - ${service.txt?.fileName || 'Unknown'} (${service.host}:${service.port})`,
          'success'
        );
        
        // Mark when first sender is found
        if (!firstSenderFoundTime) {
          firstSenderFoundTime = Date.now();
        }
      }
    });

    discovery.on('service-down', (service: ServiceInfo) => {
      if (service.txt?.role === 'sender') {
        senders.delete(service.id);
        CliUI.showProgressInfo(`Sender left: ${service.name}`, 'info');
      }
    });

    discovery.startDiscovery();

    // Get local IP addresses
    const { getLocalIpAddresses } = require('@howl/core');
    const localIPs = getLocalIpAddresses();
    
    CliUI.showServerInfo({
      mode: 'receive',
      port: serverPort,
      localIPs,
      verificationEnabled: true,
    });
    
    CliUI.showConnectionInstructions('receive');
    CliUI.showWaiting('receive');
    this.log(chalk.gray('Senders can upload via HTTP or you can discover senders via mDNS.\n'));

    // Start searching for senders in background
    this.log(chalk.cyan('🔍 Searching for senders in background...\n'));
    let firstSenderFoundTime: number | null = null;
    let searchTimedOut = false;

    // Check if 3 seconds passed since first sender found
    const checkSearchTimeout = setInterval(() => {
      if (firstSenderFoundTime && Date.now() - firstSenderFoundTime >= 3000 && !searchTimedOut) {
        searchTimedOut = true;
        clearInterval(checkSearchTimeout);
        
        // Show selection menu
        this.showSenderSelectionMenu(senders, discovery, receiver, outputDir).catch(err => {
          console.error('[Receive] Error in selection menu:', err);
        });
      }
    }, 100);

    // Handle Ctrl+C gracefully
    const cleanup = async () => {
      this.log(chalk.yellow('\n\n👋 Shutting down...'));
      await receiver.stopServer();
      discovery.destroy();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Keep the process running
    await new Promise(() => {
      // Run indefinitely until interrupted
    });
  }

  /**
   * Setup HTTP server and return receiver instance
   */
  private async setupHttpServer(
    outputDir: string,
    requestedPort: number,
    maxUploads: number,
    skipFirewall: boolean = false
  ): Promise<LanReceiver | null> {
    let spinner = ora('Preparing HTTP server...').start();

    // Find available port first
    spinner.text = 'Finding available port...';
    let actualPort: number;
    try {
      // Default to 40001 for receiver if no port specified
      const defaultPort = requestedPort > 0 ? requestedPort : 40001;
      const userSpecified = requestedPort > 0;
      actualPort = await FirewallHelper.findAvailablePort(
        defaultPort,
        userSpecified
      );
      spinner.succeed(`Found available port: ${actualPort}`);
    } catch (error) {
      spinner.fail('Port not available');
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(chalk.red(message));
      return null;
    }

    // Windows Firewall handling
    if (!skipFirewall && FirewallHelper.isWindows()) {
      spinner = ora('Checking Windows Firewall...').start();

      try {
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
    const receiver = new LanReceiver();
    receiver.setUploadDir(outputDir);
    receiver.setMaxUploads(maxUploads);

    try {
      const serverPort = await receiver.startServer(actualPort);
      spinner.succeed(`HTTP server started on 0.0.0.0:${serverPort}`);

      // Get local IP addresses
      const { getLocalIpAddresses } = require('@howl/core');
      const localIPs = getLocalIpAddresses();

      this.log(chalk.green('\n🚀 HTTP server ready to receive uploads'));
      this.log(chalk.gray(`Files will be saved to: ${outputDir}\n`));

      this.log(chalk.cyan('📱 Senders can upload via:'));
      this.log(chalk.white(`   🌐 Web: Open ${chalk.bold.underline.cyan(`http://${localIPs[0]}:${serverPort}`)}`));
      this.log(chalk.gray(`\n   📝 Upload process:`));
      this.log(chalk.gray(`      1. Select file in browser`));
      this.log(chalk.gray(`      2. Click "Request Upload"`));
      this.log(chalk.gray(`      3. Verification code will appear here`));
      this.log(chalk.gray(`      4. Enter code in browser to upload`));

      // Show alternative IPs if there are multiple
      if (localIPs.length > 1) {
        this.log(chalk.gray(`\n📡 Alternative addresses (if above doesn't work):`));
        for (const ip of localIPs.slice(1, 3)) {
          this.log(chalk.gray(`   🌐 http://${ip}:${serverPort}`));
        }
      }

      this.log(chalk.gray(`\n📊 Upload limit: ${maxUploads === 0 ? 'Unlimited' : maxUploads}`));

      // Setup event handlers for two-stage upload
      receiver.on('upload-requested', (data: any) => {
        this.log(chalk.cyan('\n' + '='.repeat(60)));
        this.log(chalk.cyan.bold('📤 Upload Request Received'));
        this.log(chalk.cyan('='.repeat(60)));
        this.log(chalk.white(`\n  📁 File: ${chalk.bold(data.filename)}`));
        this.log(chalk.white(`  📊 Size: ${this.formatBytes(data.size)}`));
        this.log(chalk.white(`  🔑 Hash: ${data.hash.substring(0, 16)}...`));
        this.log(chalk.white(`  📅 Created: ${new Date(data.createdAt).toLocaleString()}`));
        this.log(chalk.white(`  ✏️  Modified: ${new Date(data.modifiedAt).toLocaleString()}`));
        this.log(chalk.white(`  🌐 From: ${data.clientIp}`));
        this.log(chalk.cyan('\n' + '='.repeat(60)));
        this.log(chalk.yellow.bold(`  🔐 Verification Code: ${data.verificationCode}`));
        this.log(chalk.cyan('='.repeat(60)));
        this.log(chalk.gray('\n  Tell the sender to enter this code in the browser.\n'));
      });

      receiver.on('upload-verified', (data: any) => {
        this.log(chalk.green(`\n✅ Verification successful for ${chalk.bold(data.filename)} from ${data.clientIp}`));
        this.log(chalk.gray(`   Receiving file...\n`));
      });

      receiver.on('verification-failed', (data: any) => {
        this.log(chalk.red(`\n❌ Verification failed for ${chalk.bold(data.filename)} from ${data.clientIp}`));
        this.log(chalk.gray(`   Invalid code provided\n`));
      });

      receiver.on('upload-completed', (data: any) => {
        this.log(chalk.green(`\n✅ File uploaded successfully!`));
        this.log(chalk.white(`   📁 File: ${chalk.bold(data.fileName)}`));
        this.log(chalk.white(`   📊 Size: ${this.formatBytes(data.size)}`));
        this.log(chalk.white(`   🔑 Hash: ${data.hash.substring(0, 16)}... (verified)`));
        this.log(chalk.white(`   🌐 From: ${data.clientIp}`));
        this.log(chalk.gray(`   💾 Saved to: ${path.join(outputDir, data.fileName)}`));
        this.log(chalk.gray(`   📈 Uploads: ${data.uploadCount}/${data.maxUploads}\n`));
      });

      receiver.on('upload-limit-reached', (data: any) => {
        this.log(chalk.yellow(`\n📊 Upload limit reached (${data.currentCount}/${data.maxUploads})`));
        this.log(chalk.cyan('Shutting down server...\n'));
        
        // Auto-exit after reaching limit
        setTimeout(async () => {
          await receiver.stopServer();
          process.exit(0);
        }, 1000);
      });

      return receiver;
    } catch (error) {
      spinner.fail('Failed to start server');
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(chalk.red(`Server error: ${message}`));
      return null;
    }
  }

}
