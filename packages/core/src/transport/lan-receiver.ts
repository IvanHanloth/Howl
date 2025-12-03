import { EventEmitter } from 'events';
import * as http from 'http';
import * as fs from 'fs';
import { FileMetadata, TransferProgress, VerificationResponse } from '../types';

/**
 * LAN Receiver - HTTP Client for file download
 * Supports resumable downloads with Range requests
 */
export class LanReceiver extends EventEmitter {
  private sessionToken?: string;

  constructor() {
    super();
  }

  /**
   * Verify with the sender using verification code
   */
  async verify(host: string, port: number, code: string): Promise<boolean> {
    const url = `http://${host}:${port}/verify`;
    const postData = JSON.stringify({ code });

    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const request = http.request(url, options, res => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const result: VerificationResponse = JSON.parse(data);
            if (result.success && result.sessionToken) {
              this.sessionToken = result.sessionToken;
              this.emit('verified', { code, sessionToken: result.sessionToken });
              resolve(true);
            } else {
              this.emit('verification-failed', { code, message: result.message });
              resolve(false);
            }
          } catch (err) {
            reject(new Error('Failed to parse verification response'));
          }
        });
      });

      request.on('error', reject);
      request.write(postData);
      request.end();
    });
  }

  /**
   * Download file from HTTP server
   */
  async download(
    host: string,
    port: number,
    fileId: string,
    outputPath: string,
    options?: {
      resume?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<FileMetadata> {
    const url = `http://${host}:${port}/${fileId}`;

    // Check if file exists for resume
    let startByte = 0;
    if (options?.resume && fs.existsSync(outputPath)) {
      startByte = fs.statSync(outputPath).size;
    }

    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        ...(startByte > 0 ? { Range: `bytes=${startByte}-` } : {}),
        ...(this.sessionToken ? { 'X-Session-Token': this.sessionToken } : {}),
      };

      const requestOptions: http.RequestOptions = {
        method: 'GET',
        headers,
      };

      const request = http.get(url, requestOptions, res => {
        const statusCode = res.statusCode || 0;

        if (statusCode !== 200 && statusCode !== 206) {
          reject(new Error(`HTTP ${statusCode}: ${res.statusMessage}`));
          return;
        }

        // Parse file metadata from headers
        const contentLength = parseInt(res.headers['content-length'] || '0', 10);
        const contentRange = res.headers['content-range'];
        const fileName = this.parseFileName(res.headers['content-disposition']) || fileId;
        const mimeType = res.headers['content-type'];

        let totalSize = contentLength;
        if (contentRange) {
          const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
          if (match) {
            totalSize = parseInt(match[1], 10);
          }
        }

        const fileMetadata: FileMetadata = {
          id: fileId,
          name: fileName,
          size: totalSize,
          mimeType,
          path: outputPath,
        };

        this.emit('metadata', fileMetadata);

        // Create write stream (append if resuming)
        const writeStream = fs.createWriteStream(outputPath, {
          flags: startByte > 0 ? 'a' : 'w',
        });

        let transferred = startByte;
        const startTime = Date.now();

        res.on('data', (chunk: Buffer) => {
          transferred += chunk.length;

          const progress: TransferProgress = {
            fileId,
            fileName,
            transferred,
            total: totalSize,
            percentage: (transferred / totalSize) * 100,
            speed: ((transferred - startByte) / (Date.now() - startTime)) * 1000,
            eta: ((totalSize - transferred) / (((transferred - startByte) / (Date.now() - startTime)) * 1000)),
          };

          this.emit('progress', progress);
        });

        res.pipe(writeStream);

        writeStream.on('finish', () => {
          this.emit('completed', fileMetadata);
          resolve(fileMetadata);
        });

        writeStream.on('error', err => {
          this.emit('error', err);
          reject(err);
        });
      });

      request.on('error', err => {
        this.emit('error', err);
        reject(err);
      });

      // Handle abort signal
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          request.destroy();
          reject(new Error('Download aborted'));
        });
      }
    });
  }

  /**
   * Fetch file list from server
   */
  async fetchFileList(host: string, port: number): Promise<FileMetadata[]> {
    const url = `http://${host}:${port}/files`;

    return new Promise((resolve, reject) => {
      http.get(url, res => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const files = JSON.parse(data) as FileMetadata[];
            resolve(files);
          } catch (err) {
            reject(new Error('Failed to parse file list'));
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Parse filename from Content-Disposition header
   */
  private parseFileName(disposition?: string): string | null {
    if (!disposition) return null;

    const match = disposition.match(/filename="?([^"]+)"?/);
    return match ? match[1] : null;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.removeAllListeners();
  }
}
