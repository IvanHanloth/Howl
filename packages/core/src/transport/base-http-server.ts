import { EventEmitter } from 'events';
import * as http from 'http';
import { DebugLogger } from '../utils/logger';

/**
 * Base HTTP Server class
 * Provides common server management functionality for LanSender and LanReceiver
 */
export abstract class BaseHttpServer extends EventEmitter {
  protected logger: DebugLogger;
  protected server?: http.Server;
  protected port: number = 0;
  protected activeConnections: Set<http.IncomingMessage> = new Set();

  constructor(protected defaultPort: number = 0) {
    super();
    this.logger = new DebugLogger(this.getLogPrefix());
  }

  /**
   * Start HTTP server
   */
  async startServer(): Promise<number> {
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

        this.handleRequest(req, res).catch(err => {
          this.logger.error('Request error:', err);
          this.activeConnections.delete(req);
          res.statusCode = 500;
          res.end('Internal Server Error');
        });
      });

      this.server.on('error', reject);

      // Bind to 0.0.0.0 to allow LAN access (not just localhost)
      this.server.listen(this.defaultPort, '0.0.0.0', () => {
        const addr = this.server?.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        this.logger.info(`HTTP server started on 0.0.0.0:${this.port}`);
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
        this.cleanup();
        resolve();
        return;
      }

      this.logger.debug('Stopping server...');

      // Force close after 1 second
      const forceCloseTimer = setTimeout(() => {
        this.logger.debug('Force closing server');
        
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
        this.cleanup();
        resolve();
      }, 1000);

      // Try graceful close first
      this.server.close(err => {
        clearTimeout(forceCloseTimer);
        if (err) {
          this.logger.debug('Server close error (ignoring):', err.message);
        } else {
          this.logger.debug('HTTP server stopped gracefully');
        }
        this.cleanup();
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
   * Abstract method for handling HTTP requests
   * Must be implemented by subclasses
   */
  protected abstract handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;

  /**
   * Abstract method for cleanup logic
   * Can be overridden by subclasses
   */
  protected cleanup(): void {
    this.server = undefined;
    this.activeConnections.clear();
    this.emit('server-stopped');
  }

  /**
   * Abstract method for getting log prefix
   * Should be overridden by subclasses
   */
  protected abstract getLogPrefix(): string;
}
