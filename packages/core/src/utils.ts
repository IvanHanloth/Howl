import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a unique peer ID
 */
export function generatePeerId(): string {
  return uuidv4();
}

/**
 * Generate a 6-digit room code for P2P connections
 */
export function generateRoomCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const absBytes = Math.abs(bytes);
  const i = Math.floor(Math.log(absBytes) / Math.log(k));

  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(dm)} ${sizes[i]}`;
}

/**
 * Format speed (bytes/sec) to human-readable string
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Format time in seconds to human-readable string
 */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--';
  
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  } else if (m > 0) {
    return `${m}m ${s}s`;
  } else {
    return `${s}s`;
  }
}

/**
 * Get local IP addresses
 */
export function getLocalIpAddresses(): string[] {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }

  return addresses;
}

/**
 * Validate file path
 */
export function validateFilePath(filePath: string): boolean {
  const fs = require('fs');
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Get file extension
 */
export function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Get MIME type from file extension
 */
export function getMimeType(filename: string): string {
  const ext = getFileExtension(filename);
  
  const mimeTypes: Record<string, string> = {
    // Video
    mp4: 'video/mp4',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    webm: 'video/webm',
    
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    
    // Archives
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    
    // Text
    txt: 'text/plain',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Parse HTTP Range header
 * @param rangeHeader - The Range header value (e.g., "bytes=0-499")
 * @param totalSize - Total size of the file
 * @returns Object with start and end positions, or null if invalid
 */
export function parseRange(rangeHeader: string, totalSize: number): { start: number; end: number } | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }

  const rangeValue = rangeHeader.replace(/bytes=/, '');
  if (!rangeValue) {
    return null;
  }

  const parts = rangeValue.split('-');
  
  // Handle suffix-byte-range-spec (e.g., "bytes=-500")
  if (!parts[0] && parts[1]) {
    const suffix = parseInt(parts[1], 10);
    if (isNaN(suffix) || suffix <= 0) {
      return null;
    }
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }

  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

  // Validate range
  if (isNaN(start) || isNaN(end) || start < 0 || start >= totalSize || start > end) {
    return null;
  }

  // Clamp end to file size
  return {
    start,
    end: Math.min(end, totalSize - 1),
  };
}
