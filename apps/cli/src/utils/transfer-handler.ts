import { LanReceiver, TransferProgress } from '@howl/core';
import chalk from 'chalk';
import cliProgress from 'cli-progress';
import ora from 'ora';
import * as path from 'path';
import prompts from 'prompts';
import { CliUI } from './ui-helper.js';

/**
 * 传输处理器 - 统一处理文件上传和下载的进度显示
 */
export class TransferHandler {
  /**
   * 从发送端下载文件
   */
  static async downloadFile(
    receiver: LanReceiver,
    host: string,
    port: number,
    fileName: string,
    outputDir: string,
    verificationCode?: string
  ): Promise<void> {
    // 如果需要验证码，先进行验证
    if (verificationCode) {
      const verificationSpinner = ora('Verifying...').start();
      try {
        const verified = await receiver.verify(host, port, verificationCode);
        if (!verified) {
          verificationSpinner.fail('Verification failed');
          throw new Error('Verification failed');
        }
        verificationSpinner.succeed('✓ Verified');
      } catch (error) {
        verificationSpinner.fail('Verification failed');
        throw error;
      }
    }

    const outputPath = path.join(outputDir, fileName);
    const outputFileName = path.basename(outputPath);
    console.log(chalk.cyan(`⬇ Downloading: ${outputFileName}`));

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
        progressBar.start(Math.ceil(progress.total / 1024 / 1024), 0);
        progressStarted = true;
      }
      progressBar.update(Math.ceil(progress.transferred / 1024 / 1024), {
        speed: this.formatSpeed(progress.speed),
        eta: progress.eta.toFixed(0),
      });
    });

    try {
      await receiver.download(host, port, fileName, outputPath);
      progressBar.stop();
      console.log(chalk.green(`✓ Downloaded: ${outputFileName}`));
    } catch (error) {
      progressBar.stop();
      console.error(chalk.red('✗ Download failed:'), error);
      throw error;
    }
  }

  /**
   * 上传文件到接收端
   */
  static async uploadFile(
    receiver: LanReceiver,
    host: string,
    port: number,
    filePath: string,
    verificationCode: string
  ): Promise<void> {
    const fileName = path.basename(filePath);
    const uploadSpinner = ora(`Uploading: ${fileName}`).start();

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

    receiver.on('progress', (progress: TransferProgress) => {
      if (!progressStarted) {
        uploadSpinner.stop();
        progressBar.start(Math.ceil(progress.total / 1024 / 1024), 0);
        progressStarted = true;
      }
      progressBar.update(Math.ceil(progress.transferred / 1024 / 1024), {
        speed: this.formatSpeed(progress.speed),
        eta: progress.eta.toFixed(0),
      });
    });

    try {
      await receiver.upload(host, port, filePath, verificationCode);
      progressBar.stop();
      console.log(chalk.green(`✓ Uploaded: ${fileName}`));
    } catch (error) {
      progressBar.stop();
      uploadSpinner.fail('Upload failed');
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      throw error;
    }
  }

  /**
   * 提示用户输入验证码
   */
  static async promptVerificationCode(): Promise<string | null> {
    const codeResponse = await prompts({
      type: 'text',
      name: 'code',
      message: 'Enter verification code:',
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
      console.log(chalk.yellow('Cancelled'));
      return null;
    }

    return codeResponse.code.trim();
  }

  /**
   * 格式化字节大小
   */
  private static formatBytes(bytes: number): string {
    return CliUI.formatBytes(bytes);
  }

  /**
   * 格式化速度
   */
  private static formatSpeed(bytesPerSecond: number): string {
    return `${this.formatBytes(bytesPerSecond)}/s`;
  }
}
