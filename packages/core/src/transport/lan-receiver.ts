import { EventEmitter } from 'events';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileMetadata, TransferProgress, VerificationResponse } from '../types';

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
  verificationCode: string;
  timestamp: number;
  verified: boolean;
}

/**
 * LAN Receiver - HTTP Client for file download and HTTP Server for file upload
 * Supports resumable downloads with Range requests and file uploads with two-stage verification
 */
export class LanReceiver extends EventEmitter {
  private sessionToken?: string;
  // Server-side properties for receiving uploads
  private server?: http.Server;
  private port: number = 0;
  private uploadCount: number = 0;
  private maxUploads: number = 0; // 0 means unlimited
  private activeConnections: Set<http.IncomingMessage> = new Set();
  private uploadDir: string = './downloads';
  // Track pending upload requests
  private pendingUploads: Map<string, UploadRequest> = new Map();

  constructor() {
    super();
  }

  /**
   * Generate a 6-digit verification code for a specific upload
   */
  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Set maximum number of uploads allowed
   */
  setMaxUploads(max: number): void {
    this.maxUploads = max;
    console.log(`[LanReceiver] Max uploads set to: ${max === 0 ? 'unlimited' : max}`);
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
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
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
    // Stop server if running
    if (this.server) {
      this.stopServer().catch(err => {
        console.error('[LanReceiver] Error stopping server:', err);
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

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // Track active connections
        this.activeConnections.add(req);
        
        req.on('end', () => {
          this.activeConnections.delete(req);
        });
        
        req.on('close', () => {
          this.activeConnections.delete(req);
        });

        this.handleUploadRequest(req, res).catch(err => {
          console.error('[LanReceiver] Request error:', err);
          this.activeConnections.delete(req);
          res.statusCode = 500;
          res.end('Internal Server Error');
        });
      });

      this.server.on('error', reject);

      // Bind to 0.0.0.0 to allow LAN access
      this.server.listen(defaultPort, '0.0.0.0', () => {
        const addr = this.server?.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        console.log(`[LanReceiver] HTTP server started on 0.0.0.0:${this.port}`);
        this.emit('server-started', this.port);
        resolve(this.port);
      });
    });
  }

  /**
   * Get the server port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Stop the HTTP server
   */
  async stopServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        this.cleanupServer();
        resolve();
        return;
      }

      console.log('[LanReceiver] Stopping server...');

      // Force close after 1 second
      const forceCloseTimer = setTimeout(() => {
        console.log('[LanReceiver] Force closing server');
        
        // Close all active connections immediately
        for (const req of this.activeConnections) {
          try {
            if (!req.socket.destroyed) {
              req.socket.destroy();
            }
          } catch (err) {
            // Ignore errors during forced shutdown
          }
        }
        this.activeConnections.clear();
        
        // Force cleanup and resolve
        this.cleanupServer();
        resolve();
      }, 1000);

      // Try graceful close first
      this.server.close(err => {
        clearTimeout(forceCloseTimer);
        if (err) {
          console.log('[LanReceiver] Server close error (ignoring):', err.message);
        } else {
          console.log('[LanReceiver] HTTP server stopped gracefully');
        }
        this.cleanupServer();
        resolve();
      });

      // Immediately try to destroy connections for faster shutdown
      for (const req of this.activeConnections) {
        try {
          if (!req.socket.destroyed) {
            req.socket.destroy();
          }
        } catch (err) {
          // Ignore errors
        }
      }
    });
  }

  /**
   * Internal cleanup method
   */
  private cleanupServer(): void {
    this.server = undefined;
    this.pendingUploads.clear();
    this.activeConnections.clear();
    this.emit('server-stopped');
  }

  /**
   * Handle HTTP upload requests
   */
  private async handleUploadRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

        // Generate unique upload ID and verification code
        const uploadId = crypto.randomBytes(16).toString('hex');
        const verificationCode = this.generateVerificationCode();

        // Store pending upload request
        const uploadRequest: UploadRequest = {
          id: uploadId,
          filename,
          size,
          hash,
          createdAt: createdAt || Date.now(),
          modifiedAt: modifiedAt || Date.now(),
          verificationCode,
          timestamp: Date.now(),
          verified: false,
        };

        this.pendingUploads.set(uploadId, uploadRequest);

        const clientIp = req.socket.remoteAddress || 'unknown';
        console.log(`[LanReceiver] Upload request from ${clientIp}: ${filename} (${size} bytes, hash: ${hash.substring(0, 8)}...)`);

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
            console.log(`[LanReceiver] Cleaned up expired upload request: ${id}`);
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
    if (uploadRequest.verificationCode !== verificationCode) {
      console.log(`[LanReceiver] Verification failed from ${clientIp} (invalid code)`);
      this.emit('verification-failed', { uploadId, filename: uploadRequest.filename, clientIp });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid verification code' }));
      return;
    }

    // Verify the hash matches the initial request
    if (uploadRequest.hash !== fileHash) {
      console.log(`[LanReceiver] Hash mismatch from ${clientIp}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'File hash does not match initial request' }));
      return;
    }

    // Mark as verified
    uploadRequest.verified = true;
    console.log(`[LanReceiver] Verification successful from ${clientIp}, receiving file...`);
    this.emit('upload-verified', { uploadId, filename: uploadRequest.filename, clientIp });

    // Parse multipart form data
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid content type' }));
      return;
    }

    const boundary = this.extractBoundary(contentType);
    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid multipart boundary' }));
      return;
    }

    try {
      const fileData = await this.parseMultipartUpload(req, boundary);
      
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
        console.error(`[LanReceiver] File hash verification failed after upload from ${clientIp}`);
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

      console.log(`[LanReceiver] File uploaded successfully: ${fileMetadata.name} from ${clientIp}`);

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
      console.error('[LanReceiver] Upload error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        message: error instanceof Error ? error.message : 'Upload failed' 
      }));
    }
  }

  /**
   * Extract boundary from Content-Type header
   */
  private extractBoundary(contentType: string): string | null {
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    return match ? (match[1] || match[2]) : null;
  }

  /**
   * Parse multipart form data upload
   */
  private async parseMultipartUpload(req: http.IncomingMessage, boundary: string): Promise<{
    filename: string;
    contentType: string;
    data: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          const boundaryBuffer = Buffer.from(`--${boundary}`);
          
          // Find file part
          const parts = this.splitBuffer(buffer, boundaryBuffer);
          
          for (const part of parts) {
            if (part.length === 0) continue;
            
            // Find header/body separator
            const separator = Buffer.from('\r\n\r\n');
            const separatorIndex = part.indexOf(separator);
            
            if (separatorIndex === -1) continue;
            
            const headerBuffer = part.slice(0, separatorIndex);
            const bodyBuffer = part.slice(separatorIndex + 4);
            
            const headers = headerBuffer.toString('utf-8');
            
            // Check if this is a file field
            const filenameMatch = headers.match(/filename="([^"]+)"/);
            if (!filenameMatch) continue;
            
            const filename = filenameMatch[1];
            const contentTypeMatch = headers.match(/Content-Type: (.+)/i);
            const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
            
            // Remove trailing boundary markers
            let data = bodyBuffer;
            const endBoundary = Buffer.from('\r\n');
            if (data.slice(-2).equals(endBoundary)) {
              data = data.slice(0, -2);
            }
            
            resolve({ filename, contentType, data });
            return;
          }
          
          reject(new Error('No file found in upload'));
        } catch (error) {
          reject(error);
        }
      });

      req.on('error', reject);
    });
  }

  /**
   * Split buffer by delimiter
   */
  private splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
    const parts: Buffer[] = [];
    let start = 0;
    let index = buffer.indexOf(delimiter);
    
    while (index !== -1) {
      parts.push(buffer.slice(start, index));
      start = index + delimiter.length;
      index = buffer.indexOf(delimiter, start);
    }
    
    if (start < buffer.length) {
      parts.push(buffer.slice(start));
    }
    
    return parts;
  }
}
