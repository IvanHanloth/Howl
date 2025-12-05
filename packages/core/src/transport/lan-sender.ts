import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { FileMetadata, TransferProgress, VerificationResponse } from '../types';
import { BaseHttpServer } from './base-http-server';
import { VerificationManager } from '../utils/verification-manager';

/**
 * LAN Sender - HTTP Server for file transfer
 * Supports Range requests for streaming
 */
export class LanSender extends BaseHttpServer {
  private files: Map<string, FileMetadata> = new Map();
  private verificationManager: VerificationManager;
  private downloadCount: number = 0;
  private maxDownloads: number = 0; // 0 means unlimited
  private requireVerification: boolean = true; // Whether verification is required

  constructor(defaultPort: number = 0) {
    super(defaultPort);
    this.verificationManager = new VerificationManager();
  }

  /**
   * Get the verification code
   */
  getVerificationCode(): string {
    return this.verificationManager.getCode();
  }

  /**
   * Set maximum number of downloads allowed
   */
  setMaxDownloads(max: number): void {
    this.maxDownloads = max;
    this.logger.debug(`Max downloads set to: ${max === 0 ? 'unlimited' : max}`);
  }

  /**
   * Set whether verification is required
   */
  setRequireVerification(required: boolean): void {
    this.requireVerification = required;
    this.logger.debug(`Verification ${required ? 'enabled' : 'disabled'}`);
  }

  /**
   * Start HTTP server and register files
   */
  async start(fileMetadata: FileMetadata): Promise<number> {
    if (!fileMetadata.path) {
      throw new Error('File path is required for LAN sender');
    }

    // Verify file exists
    if (!fs.existsSync(fileMetadata.path)) {
      throw new Error(`File not found: ${fileMetadata.path}`);
    }

    this.files.set(fileMetadata.id, fileMetadata);

    const port = await this.startServer();
    this.emit('started', port);
    return port;
  }

  /**
   * Handle HTTP requests with Range support
   */
  protected async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    // Remove query string from URL before extracting file ID
    const urlPathOnly = url.split('?')[0];
    const fileId = path.basename(urlPathOnly);

    // Root endpoint - verification web page
    if (url === '/' || url === '/index.html') {
      this.serveVerificationPage(res);
      return;
    }

    // Verification endpoint
    if (url === '/verify' && req.method === 'POST') {
      await this.handleVerification(req, res);
      return;
    }

    // Health check endpoint
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', files: this.files.size }));
      return;
    }

    // File list endpoint
    if (url === '/files') {
      const fileList = Array.from(this.files.values()).map(f => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fileList));
      return;
    }

    // File download endpoint - match by filename or file ID
    // Extract token from query string or header
    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const token = urlObj.searchParams.get('token') || (req.headers['x-session-token'] as string);
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const clientIp = req.socket.remoteAddress || 'unknown';
    
    // Identify request type based on user agent
    let transferType = 'unknown';
    let requiresVerification = this.requireVerification;
    
    if (userAgent.includes('howl-cli')) {
      transferType = 'CLI';
      // CLI doesn't need verification by default
    } else if (userAgent.includes('howl-client')) {
      transferType = 'Client';
      // Client apps need verification if enabled
    } else {
      // Browser request
      transferType = 'Browser';
      // Browser needs verification if enabled
    }
    
    // Log incoming connection
    this.emit('connection', {
      transferType,
      clientIp,
      userAgent,
      timestamp: new Date().toISOString(),
    });
    this.logger.debug(`Incoming connection from ${clientIp} (${transferType})`);
    
    // Try to find file by exact ID match or by filename
    let fileMetadata = this.files.get(fileId);
    if (!fileMetadata) {
      // Try to match by filename
      for (const [, meta] of this.files) {
        if (meta.name === fileId) {
          fileMetadata = meta;
          break;
        }
      }
    }
    
    if (!fileMetadata || !fileMetadata.path) {
      this.logger.debug(`File not found: ${fileId}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    
    // Check verification if required
    if (requiresVerification && !this.verificationManager.isSessionVerified(token)) {
      this.logger.debug(`Verification failed for ${clientIp} (${transferType})`);
      this.emit('verification-required', {
        transferType,
        clientIp,
        timestamp: new Date().toISOString(),
      });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        message: 'Verification required. Please verify first.' 
      }));
      return;
    }
    
    // Log successful verification or no-verification mode
    if (!requiresVerification) {
      this.logger.debug('Direct access allowed (verification disabled)');
    } else {
      this.logger.debug(`Verification successful for ${clientIp}`);
    }
    
    // Check download limit before serving file
    if (this.maxDownloads > 0 && this.downloadCount >= this.maxDownloads) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        message: 'Download limit reached' 
      }));
      return;
    }

    const filePath = fileMetadata.path;
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // Parse Range header
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': fileMetadata.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileMetadata.name}"`,
      });

      const stream = fs.createReadStream(filePath, { start, end });
      
      let transferred = 0;
      const startTime = Date.now();

      // Emit transfer started event
      this.emit('transfer-started', {
        fileId: fileMetadata.id,
        fileName: fileMetadata.name,
        transferType,
        clientIp,
        timestamp: new Date().toISOString(),
      });
      this.logger.debug(`Transfer started: ${fileMetadata.name} to ${clientIp} (${transferType})`);

      stream.on('data', (chunk: Buffer | string) => {
        const chunkLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        transferred += chunkLength;
        const progress: TransferProgress = {
          fileId: fileMetadata.id,
          fileName: fileMetadata.name,
          transferred: start + transferred,
          total: fileSize,
          percentage: ((start + transferred) / fileSize) * 100,
          speed: (transferred / (Date.now() - startTime)) * 1000,
          eta: ((fileSize - start - transferred) / ((transferred / (Date.now() - startTime)) * 1000)),
        };
        this.emit('progress', progress);
      });

      stream.pipe(res);
      
      // Increment download count when download starts
      res.on('finish', () => {
        this.downloadCount++;
        this.emit('transfer-completed', {
          fileId: fileMetadata.id,
          fileName: fileMetadata.name,
          transferType,
          clientIp: req.socket.remoteAddress,
          timestamp: new Date().toISOString(),
          downloadCount: this.downloadCount,
          maxDownloads: this.maxDownloads || '∞',
        });
        
        // Check if download limit reached
        if (this.maxDownloads > 0 && this.downloadCount >= this.maxDownloads) {
          this.emit('download-limit-reached', {
            currentCount: this.downloadCount,
            maxDownloads: this.maxDownloads,
          });
        }
      });
    } else {
      // Full file download
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': fileMetadata.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileMetadata.name}"`,
        'Accept-Ranges': 'bytes',
      });

      const stream = fs.createReadStream(filePath);
      
      // Emit transfer started event
      this.emit('transfer-started', {
        fileId: fileMetadata.id,
        fileName: fileMetadata.name,
        transferType,
        clientIp,
        timestamp: new Date().toISOString(),
      });
      this.logger.debug(`Transfer started: ${fileMetadata.name} to ${clientIp} (${transferType})`);
      
      let transferred = 0;
      const startTime = Date.now();

      stream.on('data', (chunk: Buffer | string) => {
        const chunkLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        transferred += chunkLength;
        const progress: TransferProgress = {
          fileId: fileMetadata.id,
          fileName: fileMetadata.name,
          transferred,
          total: fileSize,
          percentage: (transferred / fileSize) * 100,
          speed: (transferred / (Date.now() - startTime)) * 1000,
          eta: ((fileSize - transferred) / ((transferred / (Date.now() - startTime)) * 1000)),
        };
        this.emit('progress', progress);
      });

      stream.on('end', () => {
        this.emit('completed', fileMetadata);
      });

      stream.pipe(res);
      
      // Increment download count when download completes
      res.on('finish', () => {
        this.downloadCount++;
        this.emit('transfer-completed', {
          fileId: fileMetadata.id,
          fileName: fileMetadata.name,
          transferType,
          clientIp: req.socket.remoteAddress,
          timestamp: new Date().toISOString(),
          downloadCount: this.downloadCount,
          maxDownloads: this.maxDownloads || '∞',
        });
        
        // Check if download limit reached
        if (this.maxDownloads > 0 && this.downloadCount >= this.maxDownloads) {
          this.emit('download-limit-reached', {
            currentCount: this.downloadCount,
            maxDownloads: this.maxDownloads,
          });
        }
      });
    }
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    await this.stopServer();
    this.emit('stopped');
  }

  /**
   * Cleanup method override
   */
  protected cleanup(): void {
    super.cleanup();
    this.files.clear();
    this.verificationManager.clearSessions();
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    // Stop server and remove all listeners
    this.stop().catch(err => {
      this.logger.error('Error during destroy:', err);
    }).finally(() => {
      this.removeAllListeners();
    });
  }

  /**
   * Serve verification web page
   */
  private serveVerificationPage(res: http.ServerResponse): void {
    const html = fs.readFileSync(path.join(__dirname,'..','assets', 'verification.html'), 'utf-8');

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
  }

  /**
   * Handle verification request
   */
  private async handleVerification(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = '';
    
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const code = data.code?.trim();

        const result = this.verificationManager.verifyAndCreateSession(code);
        if (result.valid && result.sessionToken) {
          const sessionToken = result.sessionToken;

          const response: VerificationResponse = {
            success: true,
            message: 'Verification successful',
            sessionToken,
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));

          const clientIp = req.socket.remoteAddress || 'unknown';
          this.logger.debug(`Verification successful from ${clientIp}`);
          this.emit('verified', { code, sessionToken, clientIp });
        } else {
          const response: VerificationResponse = {
            success: false,
            message: 'Invalid verification code',
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));

          const clientIp = req.socket.remoteAddress || 'unknown';
          this.logger.debug(`Verification failed from ${clientIp} (invalid code: ${code})`);
          this.emit('verification-failed', { code, clientIp });
        }
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid request' }));
      }
    });
  }

  /**
   * Get log prefix for base class
   */
  protected getLogPrefix(): string {
    return 'LanSender';
  }
}
