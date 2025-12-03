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
} from '@howl/core';

/**
 * Receive command - Receive files from another device
 */
export default class Receive extends Command {
  static description = 'Receive a file from another device';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output ./downloads',
    '<%= config.bin %> <%= command.id %> 839210',
  ];

  static flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output directory',
      default: './downloads',
    }),
    lan: Flags.boolean({
      description: 'Force LAN mode (discover local senders)',
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
    const outputDir = path.resolve(flags.output);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    this.log(chalk.cyan('📥 howl - File Receiver\n'));

    if (args.code) {
      await this.receiveViaWan(args.code as string, outputDir);
    } else {
      await this.receiveViaLan(outputDir);
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
        // Re-search for 5 seconds
        this.log(chalk.cyan('\n🔍 Searching for 5 seconds...\n'));
        await this.researchForSenders(services, knownServiceIds);
        
        if (services.size === 0) {
          this.log(chalk.yellow('No senders found on local network.'));
          const continueSearching = await prompts({
            type: 'confirm',
            name: 'continue',
            message: 'Continue searching?',
            initial: true,
          });

          if (!continueSearching.continue) {
            discovery.destroy();
            process.exit(0);
          }
        } else {
          knownServiceIds = new Set(services.keys());
        }
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

      // Re-search for 5 seconds
      this.log(chalk.cyan('\n🔍 Searching for 5 seconds...\n'));
      await this.researchForSenders(services, knownServiceIds);
      
      if (services.size === 0) {
        this.log(chalk.yellow('No senders found on local network.'));
        const continueSearching = await prompts({
          type: 'confirm',
          name: 'continue',
          message: 'Continue searching?',
          initial: true,
        });

        if (!continueSearching.continue) {
          discovery.destroy();
          process.exit(0);
        }
      } else {
        knownServiceIds = new Set(services.keys());
      }
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
   * Re-search for senders for 5 seconds
   * Continue searching until new sender found or all known senders leave
   */
  private async researchForSenders(
    services: Map<string, ServiceInfo>,
    knownServiceIds: Set<string>
  ): Promise<void> {
    const startTime = Date.now();
    const researchDuration = 5000; // 5 seconds
    const progressBar = new cliProgress.SingleBar(
      {
        format: 'Searching |{bar}| {percentage}% | {value}s/{total}s',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    progressBar.start(5, 0);

    return new Promise<void>((resolve) => {
      const updateInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const seconds = Math.floor(elapsed / 1000);
        progressBar.update(seconds);

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

        // Stop if time limit reached
        if (elapsed >= researchDuration) {
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
