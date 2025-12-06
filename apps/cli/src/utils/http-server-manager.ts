import { LanSender, LanReceiver, FirewallHelper } from '@howl/core';
import ora from 'ora';

export interface ServerConfig {
  port: number;
  skipFirewall: boolean;
  maxLimit: number; // 对于 sender 是 maxDownloads，对于 receiver 是 maxUploads
  requireVerification: boolean;
  requirePerFileVerification?: boolean; // 仅用于 receiver，是否需要每个文件单独验证码
}

/**
 * HTTP 服务器管理器 - 统一处理 HTTP 服务器的启动、配置和防火墙设置
 */
export class HttpServerManager {
  /**
   * 启动发送端 HTTP 服务器
   */
  static async startSenderServer(
    config: ServerConfig,
    fileMetadata: { id: string; name: string; size: number; path: string }
  ): Promise<LanSender> {
    let spinner = ora('Preparing to start...').start();

    // 查找可用端口
    spinner.text = 'Finding available port...';
    let actualPort: number;
    try {
      const userSpecified = config.port > 0;
      actualPort = await FirewallHelper.findAvailablePort(
        config.port > 0 ? config.port : undefined,
        userSpecified
      );
      spinner.succeed(`Found available port: ${actualPort}`);
    } catch (error) {
      spinner.fail('Port not available');
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(message);
    }

    // Windows 防火墙处理
    if (!config.skipFirewall && FirewallHelper.isWindows()) {
      spinner = ora('Checking Windows Firewall...').start();

      try {
        const result = await FirewallHelper.ensurePortAllowed(actualPort);

        if (result.success) {
          spinner.succeed(result.message);
        } else {
          spinner.warn(result.message);
        }
      } catch (error) {
        spinner.warn('Failed to configure firewall. Server may not be accessible.');
        console.error(error);
      }
    }

    // 启动 HTTP 服务器
    spinner = ora('Starting HTTP server...').start();
    const sender = new LanSender(actualPort);

    sender.setMaxDownloads(config.maxLimit);
    sender.setRequireVerification(config.requireVerification);

    try {
      const serverPort = await sender.start(fileMetadata);
      spinner.succeed(`HTTP server started on 0.0.0.0:${serverPort}`);
      return sender;
    } catch (error) {
      spinner.fail('Failed to start sender server');
      throw error;
    }
  }

  /**
   * 启动接收端 HTTP 服务器
   */
  static async startReceiverServer(
    config: ServerConfig,
    outputDir: string
  ): Promise<LanReceiver> {
    let spinner = ora('Preparing to start...').start();

    // 查找可用端口
    spinner.text = 'Finding available port...';
    let actualPort: number;
    try {
      const userSpecified = config.port > 0;
      actualPort = await FirewallHelper.findAvailablePort(
        config.port > 0 ? config.port : undefined,
        userSpecified
      );
      spinner.succeed(`Found available port: ${actualPort}`);
    } catch (error) {
      spinner.fail('Port not available');
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(message);
    }

    // Windows 防火墙处理
    if (!config.skipFirewall && FirewallHelper.isWindows()) {
      spinner = ora('Checking Windows Firewall...').start();

      try {
        const result = await FirewallHelper.ensurePortAllowed(actualPort);

        if (result.success) {
          spinner.succeed(result.message);
        } else {
          spinner.warn(result.message);
        }
      } catch (error) {
        spinner.warn('Failed to configure firewall. Server may not be accessible.');
        console.error(error);
      }
    }

    // 启动 HTTP 服务器
    spinner = ora('Starting HTTP server...').start();
    const receiver = new LanReceiver();

    receiver.setMaxUploads(config.maxLimit);
    receiver.setUploadDir(outputDir);
    
    // Set verification mode
    receiver.setRequirePerFileVerification(config.requirePerFileVerification || false);
    
    // Display global verification code if not using per-file verification
    if (!config.requirePerFileVerification) {
      const globalCode = receiver.getGlobalVerificationCode();
      if (globalCode) {
        spinner.info(`Global verification code: ${globalCode}`);
        spinner = ora('Starting HTTP server...').start();
      }
    }

    try {
      const serverPort = await receiver.startServer(actualPort);
      spinner.succeed(`HTTP server started on 0.0.0.0:${serverPort}`);
      return receiver;
    } catch (error) {
      spinner.fail('Failed to start receiver server');
      throw error;
    }
  }
}
