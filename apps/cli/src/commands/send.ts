import { Command, Flags, Args } from '@oclif/core';
import {
  LanSender,
  LanReceiver,
  DebugLogger,
  getLocalIpAddresses,
  generatePeerId,
} from '@howl/core';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';
import cliProgress from 'cli-progress';
import { CliUI } from '../utils/ui-helper.js';
import { DeviceDiscoveryService } from '../utils/device-discovery-service.js';
import { HttpServerManager } from '../utils/http-server-manager.js';
import { TransferHandler } from '../utils/transfer-handler.js';

/**
 * Send command - Send files via LAN or P2P
 */
export default class Send extends Command {
  static description = 'Send a file to another device';

  static examples = [
    '<%= config.bin %> <%= command.id %> ./myfile.mp4',
    '<%= config.bin %> <%= command.id %> ./document.pdf --mode lan',
    '<%= config.bin %> <%= command.id %> ./video.mkv --limit 3',
  ];

  static flags = {
    mode: Flags.string({
      description: 'Transfer mode: lan or wan',
      options: ['lan', 'wan'],
      default: 'lan',
    }),
    name: Flags.string({
      description: 'Display name for this device',
      default: require('os').hostname(),
    }),
    limit: Flags.integer({
      description: 'Maximum number of downloads (0 = unlimited, default = 1)',
      default: 1,
    }),
    'no-verification': Flags.boolean({
      description: 'Disable verification code requirement',
      default: false,
    }),
    debug: Flags.boolean({
      description: 'Enable debug logging',
      default: false,
    }),
    'skip-firewall': Flags.boolean({
      description: 'Skip automatic firewall configuration (Windows only)',
      default: false,
    }),
    port: Flags.integer({
      description: 'Port for HTTP server (default: 40000 or next available)',
      default: 0,
    }),
    'disable-lan': Flags.boolean({
      description: 'Disable mDNS discovery feature',
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

    // Enable debug logging if --debug flag is set
    if (flags.debug) {
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

    CliUI.showBanner('send');
    CliUI.showFileInfo(path.basename(filePath), stat.size);

    // WAN mode
    if (flags.mode === 'wan') {
      this.log(chalk.yellow('WAN mode not yet implemented. Using LAN mode...'));
    }

    // LAN mode
    await this.sendViaLan(filePath, stat.size, flags);
  }

  /**
   * LAN 模式发送
   */
  private async sendViaLan(
    filePath: string,
    fileSize: number,
    flags: {
      port: number;
      name: string;
      limit: number;
      'no-verification': boolean;
      'skip-firewall': boolean;
      'disable-lan': boolean;
      debug: boolean;
    }
  ): Promise<void> {
    const peerId = generatePeerId();
    const fileId = path.basename(filePath);
    const requireVerification = !flags['no-verification'];

    const fileMetadata = {
      id: fileId,
      name: path.basename(filePath),
      size: fileSize,
      path: filePath,
    };

    // 启动 HTTP 服务器
    const sender = await HttpServerManager.startSenderServer(
      {
        port: flags.port,
        skipFirewall: flags['skip-firewall'],
        maxLimit: flags.limit,
        requireVerification,
      },
      fileMetadata
    );

    const serverPort = sender.getPort();
    const deviceName = flags.name;

    // 如果禁用 mDNS，则仅以服务器模式运行
    if (flags['disable-lan']) {
      const localIPs = getLocalIpAddresses();
      const primaryIP = localIPs[0] || 'localhost';
      const verificationCode = sender.getVerificationCode();
      const serverUrl = `http://${primaryIP}:${serverPort}`;

      console.log();
      console.log(chalk.green('✓ Server ready'));
      console.log(chalk.cyan(`📍 ${serverUrl}`));
      if (requireVerification) {
        console.log(chalk.cyan(`🔐 Code: ${verificationCode}`));
      }
      console.log();

      // 生成并显示二维码
      console.log(chalk.gray('Scan QR code to connect:'));
      qrcode.generate(serverUrl, { small: true });
      console.log();

      if (!requireVerification) {
        console.log(chalk.yellow('⚠ Warning: Verification is disabled!'));
        console.log(chalk.gray('  Anyone on your network can access this file.'));
        console.log();
      }

      if (flags.debug) {
        CliUI.showServerInfo({
          mode: 'send',
          port: serverPort,
          verificationCode: requireVerification ? verificationCode : undefined,
          localIPs,
          filename: fileMetadata.name,
          verificationEnabled: requireVerification,
        });
        CliUI.showConnectionInstructions('send');
      }

      console.log(chalk.gray(`Waiting for downloads (limit: ${flags.limit === 0 ? 'unlimited' : flags.limit})...`));
      console.log();

      // 设置传输事件监听
      this.setupSenderEventHandlers(sender, flags.limit);

      // 保持进程运行
      await this.keepAlive(sender);
      return;
    }

    // 启动 mDNS 发现和广播
    const discoveryService = new DeviceDiscoveryService({ mode: 'send' });
    const discovery = discoveryService.getDiscoveryInstance();

    // 广播当前发送端
    discovery.advertise(peerId, deviceName, serverPort, {
      fileName: fileMetadata.name,
      fileSize: fileSize.toString(),
      role: 'sender',
    });

    const localIPs = getLocalIpAddresses();
    const primaryIP = localIPs[0] || 'localhost';
    const verificationCode = sender.getVerificationCode();
    const serverUrl = `http://${primaryIP}:${serverPort}`;

    console.log();
    console.log(chalk.green('✓ Server ready and broadcasting'));
    console.log(chalk.cyan(`📍 ${serverUrl}`));
    if (requireVerification) {
      console.log(chalk.cyan(`🔐 Code: ${verificationCode}`));
    }
    console.log();

    // 生成并显示二维码
    console.log(chalk.gray('Scan QR code to connect:'));
    qrcode.generate(serverUrl, { small: true });
    console.log();

    if (!requireVerification) {
      console.log(chalk.yellow('⚠ Warning: Verification is disabled!'));
      console.log(chalk.gray('  Anyone on your network can access this file.'));
      console.log();
    }

    if (flags.debug) {
      CliUI.showServerInfo({
        mode: 'send',
        port: serverPort,
        verificationCode: requireVerification ? verificationCode : undefined,
        localIPs,
        filename: fileMetadata.name,
        verificationEnabled: requireVerification,
      });
      CliUI.showConnectionInstructions('send');
    }

    console.log(chalk.gray(`Limit: ${flags.limit === 0 ? 'unlimited' : flags.limit} downloads`));
    console.log();

    // 设置传输事件监听
    this.setupSenderEventHandlers(sender, flags.limit);

    // 开始发现接收端
    await discoveryService.startDiscovery();

    // 显示接收端选择菜单
    const selectedReceiver = await discoveryService.showDeviceSelectionMenu();

    if (!selectedReceiver) {
      console.log(chalk.gray('No device selected, continuing in server mode...'));
      console.log();
      await this.keepAlive(sender);
      return;
    }

    // 用户选择了接收端 - 连接并上传（不停止服务器和 mDNS）
    console.log(chalk.cyan('\n🔗 Connecting to receiver...'));

    // 提示输入验证码
    console.log(chalk.cyan('\n🔐 Verification Required'));
    console.log(chalk.gray('Ask the receiver to provide their verification code.'));
    console.log();

    const code = await TransferHandler.promptVerificationCode();
    if (!code) {
      console.log(chalk.yellow('Cancelled, continuing in server mode...'));
      console.log();
      // 继续运行服务器
      await this.keepAlive(sender);
      return;
    }

    // 上传文件（使用新的 receiver 实例，不影响服务器）
    const receiver = new LanReceiver();
    try {
      await TransferHandler.uploadFile(
        receiver,
        selectedReceiver.host,
        selectedReceiver.port,
        filePath,
        code
      );
      
      // 上传完成后，继续运行服务器等待更多连接
      console.log(chalk.green('Upload complete!'));
      console.log(chalk.gray('Server still running, waiting for more connections...'));
      console.log();
    } catch (error) {
      console.log(chalk.red('Upload failed:'), error instanceof Error ? error.message : error);
      console.log(chalk.gray('Server still running...'));
      console.log();
    }

    // 继续运行服务器
    await this.keepAlive(sender);
  }

  /**
   * 设置发送端事件处理
   */
  private setupSenderEventHandlers(sender: LanSender, maxDownloads: number): void {
    let progressBar: cliProgress.SingleBar | null = null;
    let progressStarted = false;

    sender.on('connection', (data: any) => {
      console.log(chalk.cyan(`📥 ${data.ip}`));
    });

    sender.on('verified', (data: any) => {
      console.log(chalk.green(`✓ Verified: ${data.ip}`));
    });

    sender.on('verification-failed', (data: any) => {
      console.log(chalk.red(`✗ Verification failed: ${data.ip}`));
    });

    sender.on('transfer-started', (data: any) => {
      console.log(chalk.cyan(`🚀 Sending to ${data.ip}...`));

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
    });

    sender.on('progress', (progress: any) => {
      if (!progressStarted && progressBar) {
        progressBar.start(Math.ceil(progress.total / 1024 / 1024), 0);
        progressStarted = true;
      }
      if (progressBar) {
        progressBar.update(Math.ceil(progress.transferred / 1024 / 1024), {
          speed: this.formatSpeed(progress.speed),
          eta: progress.eta.toFixed(0),
        });
      }
    });

    sender.on('transfer-completed', (data: any) => {
      if (progressBar) {
        progressBar.stop();
        progressBar = null;
        progressStarted = false;
      }
      console.log(chalk.green(`✓ Sent to ${data.ip} (${CliUI.formatBytes(data.size)})`));
    });

    sender.on('download-limit-reached', () => {
      console.log();
      console.log(chalk.yellow(`⚠ Download limit reached (${maxDownloads} downloads)`));
      console.log(chalk.gray('Shutting down server...'));
      sender.stop().then(() => {
        process.exit(0);
      });
    });

    sender.on('completed', () => {
      console.log();
      console.log(chalk.green('✓ All transfers completed'));
      sender.stop().then(() => {
        process.exit(0);
      });
    });
  }

  /**
   * 保持进程运行
   */
  private async keepAlive(sender: LanSender): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Handle graceful shutdown
      const cleanup = async () => {
        console.log(chalk.yellow('\n\nShutting down...'));
        try {
          await sender.stop();
          resolve();
          process.exit(0);
        } catch (error) {
          reject(error);
          process.exit(1);
        }
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    });
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
}
