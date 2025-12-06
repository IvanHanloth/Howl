import { LanDiscovery, ServiceInfo } from '@howl/core';
import ora from 'ora';
import chalk from 'chalk';
import prompts from 'prompts';
import cliProgress from 'cli-progress';
import { CliUI } from './ui-helper.js';

export interface DiscoveryOptions {
  mode: 'send' | 'receive';
  autoShowDelay?: number; // 发现首个设备后多久自动显示菜单（毫秒）
  researchDuration?: number; // 重新搜索的持续时间（毫秒）
}

/**
 * 设备发现服务 - 统一处理设备发现、搜索和选择
 */
export class DeviceDiscoveryService {
  private discovery: LanDiscovery;
  private devices: Map<string, ServiceInfo> = new Map();
  private options: DiscoveryOptions;
  private spinner: ora.Ora | null = null;

  constructor(options: DiscoveryOptions) {
    this.discovery = new LanDiscovery();
    this.options = {
      autoShowDelay: 3000,
      researchDuration: 5000,
      ...options,
    };
  }

  /**
   * 启动设备发现
   * 持续搜索直到至少发现一个设备，然后在延迟后显示设备列表
   */
  async startDiscovery(): Promise<void> {
    const deviceType = this.options.mode === 'send' ? 'receiver' : 'sender';
    this.spinner = ora(`Searching for ${deviceType}s...`).start();

    let selectionTimeout: NodeJS.Timeout | null = null;
    let shouldShowMenu = false;

    this.discovery.on('service-up', (service: ServiceInfo) => {
      const serviceId = `${service.host}:${service.port}`;
      
      // 过滤：只显示对应角色的设备
      const role = service.txt?.role;
      if (this.options.mode === 'send' && role !== 'receiver') return;
      if (this.options.mode === 'receive' && role !== 'sender') return;

      this.devices.set(serviceId, service);
      this.spinner?.succeed(`Found: ${service.txt?.name || service.name}`);
      this.spinner = ora(`Searching...`).start();

      // 首次发现设备，设置自动显示菜单的定时器
      if (this.devices.size === 1 && !selectionTimeout) {
        selectionTimeout = setTimeout(() => {
          shouldShowMenu = true;
        }, this.options.autoShowDelay);
      }
    });

    this.discovery.on('service-down', (service: ServiceInfo) => {
      const serviceId = `${service.host}:${service.port}`;
      if (this.devices.has(serviceId)) {
        this.devices.delete(serviceId);
        // 静默移除，不显示断开连接的消息
      }
    });

    this.discovery.startDiscovery();

    // 等待至少发现一个设备，然后等待延迟后自动显示菜单
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.devices.size > 0 && shouldShowMenu) {
          clearInterval(checkInterval);
          if (selectionTimeout) clearTimeout(selectionTimeout);
          this.spinner?.stop();
          resolve();
        }
      }, 100);

      // 如果没有设备，继续等待
    });
  }

  /**
   * 显示设备选择菜单，支持重新搜索
   */
  async showDeviceSelectionMenu(): Promise<ServiceInfo | null> {
    const deviceType = this.options.mode === 'send' ? 'receiver' : 'sender';
    let knownDeviceIds = new Set(this.devices.keys());

    while (true) {
      if (this.devices.size === 0) {
        console.log(chalk.yellow(`\nNo ${deviceType}s found.\n`));
        
        const researchResponse = await prompts({
          type: 'confirm',
          name: 'research',
          message: `Search for ${deviceType}s?`,
          initial: true,
        });

        if (!researchResponse.research) {
          return null;
        }

        await this.researchDevices(knownDeviceIds);
        knownDeviceIds = new Set(this.devices.keys());
        continue;
      }

      // 显示发现的设备
      const deviceArray = Array.from(this.devices.values());
      const devices = deviceArray.map((service: ServiceInfo) => ({
        name: service.txt?.name || service.name,
        ip: service.host,
        port: service.port,
        fileName: service.txt?.fileName,
        fileSize: service.txt?.fileSize ? this.formatBytes(parseInt(service.txt.fileSize, 10)) : undefined,
      }));

      CliUI.showDiscoveryBox({
        mode: this.options.mode,
        deviceCount: this.devices.size,
        devices,
      });

      console.log(chalk.gray(`You can select a ${deviceType} or press Ctrl+C to cancel.\n`));

      // 构建选择菜单
      const choices = deviceArray.map((service: ServiceInfo) => {
        let title = `${service.txt?.name || service.name}`;
        if (this.options.mode === 'receive' && service.txt?.fileName) {
          title += ` - ${service.txt.fileName}`;
        }

        let description = `${service.host}:${service.port}`;
        if (service.txt?.fileSize) {
          description += ` (${this.formatBytes(parseInt(service.txt.fileSize, 10))})`;
        }

        return {
          title,
          description,
          value: service,
        };
      });

      choices.push({
        title: chalk.cyan('🔄 Search again (R)'),
        description: 'Continue searching for more devices',
        value: 'RESEARCH' as any,
      });

      console.log(chalk.cyan(`📋 Select a ${deviceType}:\n`));

      const response = await prompts({
        type: 'select',
        name: 'device',
        message: `Select a ${deviceType}:`,
        choices,
      });

      if (!response.device) {
        // 用户取消
        console.log(chalk.yellow('\nNo device selected.\n'));
        
        const researchResponse = await prompts({
          type: 'confirm',
          name: 'research',
          message: `Search for more ${deviceType}s?`,
          initial: true,
        });

        if (!researchResponse.research) {
          return null;
        }

        await this.researchDevices(knownDeviceIds);
        knownDeviceIds = new Set(this.devices.keys());
        continue;
      }

      if (response.device === 'RESEARCH') {
        console.log(chalk.cyan('\n🔍 Searching for more devices...\n'));
        await this.researchDevices(knownDeviceIds);
        knownDeviceIds = new Set(this.devices.keys());
        continue;
      }

      // 用户选择了一个设备
      return response.device as ServiceInfo;
    }
  }

  /**
   * 重新搜索设备
   * 如果已有设备，搜索指定时长；如果没有设备，持续搜索直到发现至少一个
   */
  private async researchDevices(knownDeviceIds: Set<string>): Promise<void> {
    const startTime = Date.now();
    const hasInitialDevices = this.devices.size > 0;
    const duration = this.options.researchDuration || 5000;

    const progressBar = new cliProgress.SingleBar(
      {
        format: hasInitialDevices
          ? 'Searching |{bar}| {percentage}% | {value}s/{total}s'
          : 'Searching for devices... ({value}s elapsed)',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    progressBar.start(hasInitialDevices ? Math.floor(duration / 1000) : 0, 0);

    return new Promise<void>((resolve) => {
      const updateInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const elapsedSeconds = Math.floor(elapsed / 1000);

        if (hasInitialDevices) {
          // 有设备：搜索指定时长
          progressBar.update(elapsedSeconds);
          if (elapsed >= duration) {
            clearInterval(updateInterval);
            progressBar.stop();

            // 显示新发现的设备
            const newDevices = Array.from(this.devices.keys()).filter(
              (id) => !knownDeviceIds.has(id)
            );
            if (newDevices.length > 0) {
              console.log(chalk.green(`\n✓ Found ${newDevices.length} new device(s)\n`));
            } else {
              console.log(chalk.yellow('\nNo new devices found\n'));
            }

            resolve();
          }
        } else {
          // 无设备：持续搜索直到找到至少一个
          progressBar.update(elapsedSeconds);
          if (this.devices.size > 0) {
            clearInterval(updateInterval);
            progressBar.stop();
            console.log(chalk.green(`\n✓ Found ${this.devices.size} device(s)\n`));
            resolve();
          }
        }
      }, 1000);
    });
  }

  /**
   * 停止发现服务
   */
  stop(): void {
    this.discovery.stopDiscovery();
    this.spinner?.stop();
  }

  /**
   * 销毁发现服务
   */
  destroy(): void {
    this.discovery.destroy();
    this.spinner?.stop();
  }

  /**
   * 获取发现实例（用于广播）
   */
  getDiscoveryInstance(): LanDiscovery {
    return this.discovery;
  }

  /**
   * 格式化字节大小
   */
  private formatBytes(bytes: number): string {
    return CliUI.formatBytes(bytes);
  }
}
