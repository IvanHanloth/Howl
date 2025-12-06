import { Command, Flags, Args } from '@oclif/core';
import { LanReceiver, DebugLogger, getLocalIpAddresses, generatePeerId } from '@howl/core';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';
import { CliUI } from '../utils/ui-helper.js';
import { DeviceDiscoveryService } from '../utils/device-discovery-service.js';
import { HttpServerManager } from '../utils/http-server-manager.js';
import { TransferHandler } from '../utils/transfer-handler.js';

/**
 * Receive command - Receive files from another device
 */
export default class Receive extends Command {
  static description = 'Receive a file from another device';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output ./downloads',
    '<%= config.bin %> <%= command.id %> 839210',
    '<%= config.bin %> <%= command.id %> --mode lan',
    '<%= config.bin %> <%= command.id %> --port 8080 --limit 5',
  ];

  static flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output directory',
      default: './downloads',
    }),
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
      description: 'Maximum number of uploads (0 = unlimited, default = 1)',
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
      description: 'Port for HTTP server (default: 40001 or next available)',
      default: 0,
    }),
    'disable-lan': Flags.boolean({
      description: 'Disable mDNS discovery feature',
      default: false,
    }),
    'upload-verify': Flags.boolean({
      description: 'Require per-file verification code for HTTP uploads (default: false, uses global code)',
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

    // Enable debug logging if --debug flag is set
    if (flags.debug) {
      DebugLogger.setDebugMode(true);
    }

    const outputDir = path.resolve(flags.output);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    CliUI.showBanner('receive');

    // If room code provided, use WAN mode
    if (args.code || flags.mode === 'wan') {
      await this.receiveViaWan(args.code || '', outputDir);
      return;
    }

    // LAN mode
    await this.receiveViaLan(outputDir, flags);
  }

  /**
   * LAN 模式接收
   */
  private async receiveViaLan(
    outputDir: string,
    flags: {
      port: number;
      limit: number;
      'no-verification': boolean;
      'skip-firewall': boolean;
      name: string;
      'disable-lan': boolean;
      debug: boolean;
      'upload-verify': boolean;
    }
  ): Promise<void> {
    const requireVerification = !flags['no-verification'];
    const requirePerFileVerification = flags['upload-verify'];

    // 启动 HTTP 服务器
    const receiver = await HttpServerManager.startReceiverServer(
      {
        port: flags.port,
        skipFirewall: flags['skip-firewall'],
        maxLimit: flags.limit,
        requireVerification,
        requirePerFileVerification,
      },
      outputDir
    );

    const serverPort = receiver.getPort();
    const peerId = generatePeerId();
    const deviceName = flags.name;

    // 如果禁用 mDNS，则仅以服务器模式运行
    if (flags['disable-lan']) {
      const localIPs = getLocalIpAddresses();
      const primaryIP = localIPs[0] || 'localhost';
      const serverUrl = `http://${primaryIP}:${serverPort}`;

      console.log();
      console.log(chalk.green('✓ Server ready'));
      console.log(chalk.cyan(`📍 ${serverUrl}`));
      console.log();

      // 生成并显示二维码
      console.log(chalk.gray('Scan QR code to connect:'));
      qrcode.generate(serverUrl, { small: true });
      console.log();

      if (flags.debug) {
        CliUI.showServerInfo({
          mode: 'receive',
          port: serverPort,
          localIPs,
          verificationEnabled: requireVerification,
        });
        CliUI.showConnectionInstructions('receive');
      }

      console.log(chalk.gray(`Waiting for uploads (limit: ${flags.limit === 0 ? 'unlimited' : flags.limit})...`));
      console.log();

      // 设置上传完成监听
      this.setupReceiverEventHandlers(receiver, flags.limit);

      // 保持进程运行
      await this.keepAlive(receiver);
      return;
    }

    // 启动 mDNS 发现和广播
    const discoveryService = new DeviceDiscoveryService({ mode: 'receive' });
    const discovery = discoveryService.getDiscoveryInstance();

    // 广播当前接收端
    discovery.advertise(peerId, deviceName, serverPort, {
      role: 'receiver',
    });

    const localIPs = getLocalIpAddresses();
    const primaryIP = localIPs[0] || 'localhost';
    const serverUrl = `http://${primaryIP}:${serverPort}`;

    console.log();
    console.log(chalk.green('✓ Server ready and broadcasting'));
    console.log(chalk.cyan(`📍 ${serverUrl}`));
    console.log();

    // 生成并显示二维码
    console.log(chalk.gray('Scan QR code to connect:'));
    qrcode.generate(serverUrl, { small: true });
    console.log();

    if (flags.debug) {
      CliUI.showServerInfo({
        mode: 'receive',
        port: serverPort,
        localIPs,
        verificationEnabled: requireVerification,
      });
      CliUI.showConnectionInstructions('receive');
    }

    console.log(chalk.gray(`Limit: ${flags.limit === 0 ? 'unlimited' : flags.limit} uploads`));
    console.log();

    // 设置上传完成监听
    this.setupReceiverEventHandlers(receiver, flags.limit);

    // 开始发现发送端
    await discoveryService.startDiscovery();

    // 显示发送端选择菜单
    const selectedSender = await discoveryService.showDeviceSelectionMenu();

    if (!selectedSender) {
      console.log(chalk.gray('No device selected, continuing in server mode...'));
      console.log();
      await this.keepAlive(receiver);
      return;
    }

    // 用户选择了发送端 - 连接并下载（不停止服务器和 mDNS）
    console.log(chalk.cyan('\n🔗 Connecting to sender...'));

    // 提示输入验证码
    const code = await TransferHandler.promptVerificationCode();
    if (!code) {
      console.log(chalk.yellow('Cancelled, continuing in server mode...'));
      console.log();
      // 继续运行服务器
      await this.keepAlive(receiver);
      return;
    }

    // 下载文件（使用新的 receiver 实例，不影响服务器）
    const downloadReceiver = new LanReceiver();
    try {
      await TransferHandler.downloadFile(
        downloadReceiver,
        selectedSender.host,
        selectedSender.port,
        selectedSender.txt?.fileName || 'download',
        outputDir,
        code
      );
      
      // 下载完成后，继续运行服务器等待更多连接
      console.log(chalk.green('Download complete!'));
      console.log(chalk.gray('Server still running, waiting for more connections...'));
      console.log();
    } catch (error) {
      console.log(chalk.red('Download failed:'), error instanceof Error ? error.message : error);
      console.log(chalk.gray('Server still running...'));
      console.log();
    }

    // 继续运行服务器
    await this.keepAlive(receiver);
  }

  /**
   * WAN 模式接收
   */
  private async receiveViaWan(_code: string, _outputDir: string): Promise<void> {
    this.log(chalk.yellow('WAN mode not yet implemented'));
    this.log(chalk.gray('Please use LAN mode for now (run without a code)'));
  }

  /**
   * 设置接收端事件处理
   */
  private setupReceiverEventHandlers(receiver: LanReceiver, maxUploads: number): void {
    receiver.on('upload-completed', (data: any) => {
      const fileName = path.basename(data.outputPath);
      console.log(chalk.green(`✓ Received: ${fileName} (${CliUI.formatBytes(data.size)})`));
    });

    receiver.on('upload-limit-reached', () => {
      console.log();
      console.log(chalk.yellow(`⚠ Upload limit reached (${maxUploads} files)`));
      console.log(chalk.gray('Shutting down server...'));
      receiver.stopServer().then(() => {
        process.exit(0);
      });
    });
  }

  /**
   * 保持进程运行
   */
  private async keepAlive(receiver: LanReceiver): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Handle graceful shutdown
      const cleanup = async () => {
        console.log(chalk.yellow('\n\nShutting down...'));
        try {
          await receiver.stopServer();
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
}
