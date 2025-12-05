import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';

/**
 * File Utilities
 * Provides common file operations for transfer functionality
 */
export class FileUtils {
  /**
   * Calculate SHA-256 hash of a file
   */
  static calculateFileHash(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
  }

  /**
   * Extract boundary from Content-Type header
   */
  static extractBoundary(contentType: string): string | null {
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    return match ? (match[1] || match[2]) : null;
  }

  /**
   * Split buffer by delimiter
   */
  static splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
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

  /**
   * Parse multipart form data upload
   */
  static async parseMultipartUpload(
    req: http.IncomingMessage,
    boundary: string
  ): Promise<{
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
          const parts = FileUtils.splitBuffer(buffer, boundaryBuffer);
          
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
   * Parse filename from Content-Disposition header
   */
  static parseFileName(disposition?: string): string | null {
    if (!disposition) return null;

    const match = disposition.match(/filename="?([^"]+)"?/);
    return match ? match[1] : null;
  }
}
