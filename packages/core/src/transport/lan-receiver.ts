import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { FileMetadata, TransferProgress, VerificationResponse } from '../types';
import { BaseHttpServer } from './base-http-server';
import { VerificationManager } from '../utils/verification-manager';
import { FileUtils } from '../utils/file-utils';

/**
 * Upload request information
 */
interface UploadRequest {
  id: string;
  filename: string;
  size: number;
  hash: string;
  createdAt: number;
  modifiedAt: number;
  verificationManager: VerificationManager;
  timestamp: number;
  verified: boolean;
}

/**
 * LAN Receiver - HTTP Client for file download and HTTP Server for file upload
 * Supports resumable downloads with Range requests and file uploads with two-stage verification
 */
export class LanReceiver extends BaseHttpServer {
  private sessionToken?: string;
  // Server-side properties for receiving uploads
  private uploadCount: number = 0;
  private maxUploads: number = 0; // 0 means unlimited
  private uploadDir: string = './downloads';
  // Track pending upload requests
  private pendingUploads: Map<string, UploadRequest> = new Map();
  // Verification mode control
  private requirePerFileVerification: boolean = false;
  private globalVerificationManager: VerificationManager | null = null;

  constructor() {
    super(0);
  }

  /**
   * Set whether to require per-file verification codes
   * If true, each upload gets a unique verification code
   * If false, uses a single global verification code for all uploads
   */
  setRequirePerFileVerification(required: boolean): void {
    this.requirePerFileVerification = required;
    // Initialize global verification manager if not using per-file verification
    if (!required && !this.globalVerificationManager) {
      this.globalVerificationManager = new VerificationManager();
      this.logger.debug(`Global verification code: ${this.globalVerificationManager.getCode()}`);
    }
  }

  /**
   * Get the global verification code (when not using per-file verification)
   */
  getGlobalVerificationCode(): string | null {
    return this.globalVerificationManager?.getCode() || null;
  }

  /**
   * Set maximum number of uploads allowed
   */
  setMaxUploads(max: number): void {
    this.maxUploads = max;
    this.logger.debug(`Max uploads set to: ${max === 0 ? 'unlimited' : max}`);
  }

  /**
   * Set upload directory
   */
  setUploadDir(dir: string): void {
    this.uploadDir = dir;
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Calculate SHA-256 hash of a file
   */
  private calculateFileHash(filePath: string): string {
    return FileUtils.calculateFileHash(filePath);
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
    return FileUtils.parseFileName(disposition);
  }

  /**
   * Upload file to a receiver server
   * This is used when this device acts as a sender connecting to a receiver
   */
  async upload(
    host: string,
    port: number,
    filePath: string,
    verificationCode: string
  ): Promise<void> {
    // Read file
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const fileName = path.basename(filePath);
    
    // Calculate file hash
    const fileHash = this.calculateFileHash(filePath);
    
    // Get file timestamps
    const createdAt = stat.birthtimeMs;
    const modifiedAt = stat.mtimeMs;

    // Stage 1: Request upload
    const requestData = JSON.stringify({
      filename: fileName,
      size: fileSize,
      hash: fileHash,
      createdAt,
      modifiedAt,
    });

    const uploadId = await new Promise<string>((resolve, reject) => {
      const requestUrl = `http://${host}:${port}/request-upload`;
      const options: http.RequestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestData),
        },
      };

      const request = http.request(requestUrl, options, res => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.success && result.uploadId) {
              resolve(result.uploadId);
            } else {
              reject(new Error(result.message || 'Failed to request upload'));
            }
          } catch (err) {
            reject(new Error('Failed to parse upload request response'));
          }
        });
      });

      request.on('error', reject);
      request.write(requestData);
      request.end();
    });

    // Stage 2: Upload file with verification code
    const boundary = `----HowlUploadBoundary${Date.now()}`;
    const fileData = fs.readFileSync(filePath);
    
    // Build multipart form data
    const parts: Buffer[] = [];
    
    // Add file part
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`));
    parts.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
    parts.push(fileData);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    
    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const uploadUrl = `http://${host}:${port}/upload`;
      const options: http.RequestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'X-Upload-Id': uploadId,
          'X-Verification-Code': verificationCode,
          'X-File-Hash': fileHash,
        },
      };

      const request = http.request(uploadUrl, options, res => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.success) {
              this.emit('completed', { fileName });
              resolve();
            } else {
              reject(new Error(result.message || 'Upload failed'));
            }
          } catch (err) {
            reject(new Error('Failed to parse upload response'));
          }
        });
      });

      request.on('error', reject);
      
      // Track progress
      let transferred = 0;
      const startTime = Date.now();
      const chunkSize = 64 * 1024; // 64KB chunks
      
      const writeChunk = (offset: number) => {
        if (offset >= body.length) {
          request.end();
          return;
        }
        
        const chunk = body.slice(offset, Math.min(offset + chunkSize, body.length));
        transferred += chunk.length;
        
        const progress = {
          fileId: fileName,
          fileName,
          transferred,
          total: body.length,
          percentage: (transferred / body.length) * 100,
          speed: ((transferred / (Date.now() - startTime)) * 1000),
          eta: ((body.length - transferred) / ((transferred / (Date.now() - startTime)) * 1000)),
        };
        
        this.emit('progress', progress);
        
        request.write(chunk, () => {
          writeChunk(offset + chunkSize);
        });
      };
      
      writeChunk(0);
    });
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.removeAllListeners();
    // Stop server if running
    if (this.server) {
      this.stopServer().catch(err => {
        this.logger.error('Error stopping server:', err);
      });
    }
  }

  /**
   * Start HTTP server to receive file uploads
   */
  async startServer(defaultPort: number = 0): Promise<number> {
    // Ensure upload directory exists
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }

    this.defaultPort = defaultPort;
    return await super.startServer();
  }

  /**
   * Stop the HTTP server
   */
  async stopServer(): Promise<void> {
    await super.stopServer();
  }

  /**
   * Cleanup method override
   */
  protected cleanup(): void {
    super.cleanup();
    this.pendingUploads.clear();
  }

  /**
   * Handle HTTP upload requests
   */
  protected async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';

    // Root endpoint - show upload page
    if (url === '/' || url === '/index.html') {
      this.serveUploadPage(res);
      return;
    }

    // Request upload endpoint - Stage 1: Send file metadata
    if (url === '/request-upload' && req.method === 'POST') {
      await this.handleUploadRequest1(req, res);
      return;
    }

    // Upload endpoint - Stage 2: Verify code and upload file
    if (url === '/upload' && req.method === 'POST') {
      await this.handleFileUpload(req, res);
      return;
    }

    // Health check endpoint
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uploadsRemaining: this.maxUploads === 0 ? '∞' : this.maxUploads - this.uploadCount }));
      return;
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  /**
   * Serve upload web page
   */
  private serveUploadPage(res: http.ServerResponse): void {
    const html = fs.readFileSync(path.join(__dirname,'..','assets', 'upload.html'), 'utf-8');

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
  }

  /**
   * Handle Stage 1: Request upload - receive file metadata and generate verification code
   */
  private async handleUploadRequest1(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = '';
    
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { filename, size, hash, createdAt, modifiedAt } = data;

        // Validate required fields
        if (!filename || !size || !hash) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Missing required fields' }));
          return;
        }

        // Check upload limit
        if (this.maxUploads > 0 && this.uploadCount >= this.maxUploads) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Upload limit reached' 
          }));
          return;
        }

        // Generate unique upload ID and verification manager for this upload
        const crypto = require('crypto');
        const uploadId = crypto.randomBytes(16).toString('hex');
        
        // Choose verification manager based on mode
        let verificationManager: VerificationManager;
        let verificationCode: string;
        
        if (this.requirePerFileVerification) {
          // Each upload gets its own verification code
          verificationManager = new VerificationManager();
          verificationCode = verificationManager.getCode();
          this.logger.debug(`Generated per-file verification code for ${filename}: ${verificationCode}`);
        } else {
          // Use global verification code for all uploads
          if (!this.globalVerificationManager) {
            this.globalVerificationManager = new VerificationManager();
          }
          verificationManager = this.globalVerificationManager;
          verificationCode = verificationManager.getCode();
          this.logger.debug(`Using global verification code for ${filename}: ${verificationCode}`);
        }

        // Store pending upload request
        const uploadRequest: UploadRequest = {
          id: uploadId,
          filename,
          size,
          hash,
          createdAt: createdAt || Date.now(),
          modifiedAt: modifiedAt || Date.now(),
          verificationManager,
          timestamp: Date.now(),
          verified: false,
        };

        this.pendingUploads.set(uploadId, uploadRequest);

        const clientIp = req.socket.remoteAddress || 'unknown';
        this.logger.debug(`Upload request from ${clientIp}: ${filename} (${size} bytes, hash: ${hash.substring(0, 8)}...)`);

        // Emit event for CLI to display
        this.emit('upload-requested', {
          uploadId,
          filename,
          size,
          hash,
          createdAt: new Date(uploadRequest.createdAt).toISOString(),
          modifiedAt: new Date(uploadRequest.modifiedAt).toISOString(),
          verificationCode,
          clientIp,
        });

        // Return upload ID to client
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true,
          uploadId,
          message: 'Upload request received. Enter the verification code shown on receiver to proceed.'
        }));

        // Clean up old pending uploads (older than 5 minutes)
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        for (const [id, upload] of this.pendingUploads.entries()) {
          if (upload.timestamp < fiveMinutesAgo && !upload.verified) {
            this.pendingUploads.delete(id);
            this.logger.debug(`Cleaned up expired upload request: ${id}`);
          }
        }
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid request' }));
      }
    });
  }

  /**
   * Handle Stage 2: File upload - verify code and receive file
   */
  private async handleFileUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const clientIp = req.socket.remoteAddress || 'unknown';
    
    // Get upload ID and verification code from headers
    const uploadId = req.headers['x-upload-id'] as string;
    const verificationCode = req.headers['x-verification-code'] as string;
    const fileHash = req.headers['x-file-hash'] as string;

    if (!uploadId || !verificationCode || !fileHash) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Missing upload ID, verification code, or file hash' }));
      return;
    }

    // Find pending upload request
    const uploadRequest = this.pendingUploads.get(uploadId);
    if (!uploadRequest) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Upload request not found or expired' }));
      return;
    }

    // Verify the code
    const result = uploadRequest.verificationManager.verifyAndCreateSession(verificationCode);
    if (!result.valid) {
      this.logger.debug(`Verification failed from ${clientIp} (invalid code)`);
      this.emit('verification-failed', { uploadId, filename: uploadRequest.filename, clientIp });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid verification code' }));
      return;
    }

    // Verify the hash matches the initial request
    if (uploadRequest.hash !== fileHash) {
      this.logger.debug(`Hash mismatch from ${clientIp}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'File hash does not match initial request' }));
      return;
    }

    // Mark as verified
    uploadRequest.verified = true;
    this.logger.debug(`Verification successful from ${clientIp}, receiving file...`);
    this.emit('upload-verified', { uploadId, filename: uploadRequest.filename, clientIp });

    // Parse multipart form data
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid content type' }));
      return;
    }

    const boundary = FileUtils.extractBoundary(contentType);
    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid multipart boundary' }));
      return;
    }

    try {
      const fileData = await FileUtils.parseMultipartUpload(req, boundary);
      
      if (!fileData.filename) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'No file provided' }));
        return;
      }

      // Save file
      const filePath = path.join(this.uploadDir, uploadRequest.filename);
      fs.writeFileSync(filePath, fileData.data);

      // Verify file hash after upload
      const uploadedFileHash = this.calculateFileHash(filePath);
      if (uploadedFileHash !== uploadRequest.hash) {
        // Hash mismatch - delete file and reject
        fs.unlinkSync(filePath);
        this.logger.error(`File hash verification failed after upload from ${clientIp}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'File integrity check failed' }));
        return;
      }

      const fileMetadata: FileMetadata = {
        id: uploadRequest.filename,
        name: uploadRequest.filename,
        size: fileData.data.length,
        mimeType: fileData.contentType,
        path: filePath,
      };

      this.uploadCount++;
      this.pendingUploads.delete(uploadId);

      this.emit('upload-completed', {
        uploadId,
        fileId: fileMetadata.id,
        fileName: fileMetadata.name,
        size: fileMetadata.size,
        hash: uploadedFileHash,
        clientIp,
        timestamp: new Date().toISOString(),
        uploadCount: this.uploadCount,
        maxUploads: this.maxUploads || '∞',
      });

      this.logger.debug(`File uploaded successfully: ${fileMetadata.name} from ${clientIp}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: 'Upload successful',
        file: fileMetadata,
      }));

      // Check if upload limit reached
      if (this.maxUploads > 0 && this.uploadCount >= this.maxUploads) {
        this.emit('upload-limit-reached', {
          currentCount: this.uploadCount,
          maxUploads: this.maxUploads,
        });
      }
    } catch (error) {
      this.logger.error('Upload error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        message: error instanceof Error ? error.message : 'Upload failed' 
      }));
    }
  }

  /**
   * Get log prefix for base class
   */
  protected getLogPrefix(): string {
    return 'LanReceiver';
  }
}
