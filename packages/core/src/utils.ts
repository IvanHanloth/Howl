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
 * Check if network interface name looks virtual
 */
function isVirtualInterface(name: string): boolean {
  const lowerName = name.toLowerCase();
  
  // Virtual network patterns to exclude
  const virtualPatterns = [
    /^veth/,           // Docker virtual ethernet
    /^docker/,         // Docker bridge
    /^br-/,            // Docker bridge
    /^vir/,            // Hyper-V Virtual Ethernet Adapter
    /^lo/,             // Loopback
    /^wsl/,            // WSL
    /^utun/,           // macOS VPN/Tunnel
    /^tun/,            // Linux VPN/Tunnel
    /^tap/,            // TAP adapter
  ];

  // Check regex patterns
  if (virtualPatterns.some(pattern => pattern.test(lowerName))) {
    return true;
  }

  // Check name contains virtual keywords
  if (lowerName.includes('vmware') || 
      lowerName.includes('virtualbox') ||
      lowerName.includes('hyper-v') ||
      lowerName.includes('virtual') ||
      lowerName.includes('vlan') || 
      lowerName.includes('bridge') || 
      lowerName.includes('vpn') ||
      lowerName.includes('veth') ||
      lowerName.includes('docker') ||
      lowerName.includes('default switch') ||
      lowerName.includes('adapter vmnet')) {
    return true;
  }

  return false;
}

/**
 * Check if IP address is virtual/reserved
 */
function isVirtualIpRange(address: string): boolean {
  // Loopback and link-local
  if (address.startsWith('127.') || address.startsWith('169.254.')) {
    return true;
  }

  // Docker default network range (172.16.0.0 - 172.31.255.255)
  const parts = address.split('.');
  if (parts.length === 4) {
    const firstOctet = parseInt(parts[0], 10);
    const secondOctet = parseInt(parts[1], 10);
    if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

/**
 * Get local IP addresses, prioritizing physical network adapters
 * Returns physical IPs first (Ethernet, WiFi), then virtual IPs
 * Filters out Docker, VPN, WSL, and other virtual networks
 */
export function getLocalIpAddresses(): string[] {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const physicalIPs: string[] = [];
  const virtualIPs: string[] = [];

  // Physical adapter name patterns (prioritized)
  const physicalPatterns = [
    /^eth/,      // Ethernet (Linux)
    /^en[0-9]/,  // macOS Ethernet
    /^wlan/,     // WiFi (Linux)
    /^wifi/,     // WiFi (some systems)
    /^bond/,     // Bonded interfaces
    /^eno/,      // Ethernet (embedded)
    /^enp/,      // Ethernet (PCI bus)
  ];

  const isPhysicalAdapter = (name: string): boolean => {
    return physicalPatterns.some(pattern => pattern.test(name.toLowerCase()));
  };

  for (const [name, ifaces] of Object.entries(interfaces)) {
    // Check if virtual
    const isVirtual = isVirtualInterface(name);
    const isPhysical = isPhysicalAdapter(name);

    for (const iface of ifaces as any[]) {
      // Only process IPv4 addresses
      if (iface.family !== 'IPv4') {
        continue;
      }

      // Skip if it's a reserved/virtual IP range
      if (isVirtualIpRange(iface.address)) {
        continue;
      }

      // Categorize and add to appropriate list
      if (isVirtual) {
        virtualIPs.push(iface.address);
      } else if (isPhysical) {
        physicalIPs.unshift(iface.address); // Prioritize physical
      } else {
        // Unknown interface type - treat as physical if not virtual
        physicalIPs.push(iface.address);
      }
    }
  }

  // Return physical IPs first (most reliable), then virtual IPs
  return [...physicalIPs, ...virtualIPs];
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

/**
 * Detect client type from User-Agent string
 * @param userAgent - The User-Agent string from HTTP headers
 * @returns Detected client type ("browser", "mobile", "desktop", "cli")
 */

export function detectClientType(userAgent: string): string {
  const ua = userAgent.toLowerCase();
    if (ua.includes('howl-cli')) {
      return 'cli';
    } else if (ua.includes('howl-client-desktop')) {
      return 'desktop';
    } else if (ua.includes('howl-client-mobile')){
      return 'mobile';
    }else {
      return 'browser';
    }
}