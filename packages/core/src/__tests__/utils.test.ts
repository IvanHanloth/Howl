import { describe, it, expect } from 'vitest';
import { formatBytes, getMimeType, parseRange, generatePeerId } from '../utils';

describe('Utils', () => {
  describe('formatBytes', () => {
    it('should format bytes to human-readable string', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
      expect(formatBytes(1024)).toBe('1.00 KB');
      expect(formatBytes(1048576)).toBe('1.00 MB');
      expect(formatBytes(1073741824)).toBe('1.00 GB');
      expect(formatBytes(1099511627776)).toBe('1.00 TB');
    });

    it('should handle decimal places', () => {
      expect(formatBytes(1536)).toBe('1.50 KB');
      expect(formatBytes(2621440)).toBe('2.50 MB');
    });

    it('should handle negative values', () => {
      expect(formatBytes(-1024)).toBe('-1.00 KB');
    });
  });

  describe('getMimeType', () => {
    it('should return correct MIME types for common extensions', () => {
      expect(getMimeType('document.pdf')).toBe('application/pdf');
      expect(getMimeType('image.jpg')).toBe('image/jpeg');
      expect(getMimeType('image.jpeg')).toBe('image/jpeg');
      expect(getMimeType('image.png')).toBe('image/png');
      expect(getMimeType('video.mp4')).toBe('video/mp4');
      expect(getMimeType('video.mkv')).toBe('video/x-matroska');
      expect(getMimeType('audio.mp3')).toBe('audio/mpeg');
      expect(getMimeType('file.txt')).toBe('text/plain');
      expect(getMimeType('data.json')).toBe('application/json');
      expect(getMimeType('page.html')).toBe('text/html');
    });

    it('should handle uppercase extensions', () => {
      expect(getMimeType('IMAGE.JPG')).toBe('image/jpeg');
      expect(getMimeType('VIDEO.MP4')).toBe('video/mp4');
    });

    it('should return octet-stream for unknown extensions', () => {
      expect(getMimeType('file.xyz')).toBe('application/octet-stream');
      expect(getMimeType('noext')).toBe('application/octet-stream');
    });
  });

  describe('parseRange', () => {
    it('should parse valid range headers', () => {
      expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
      expect(parseRange('bytes=500-999', 1000)).toEqual({ start: 500, end: 999 });
      expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
      expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    });

    it('should handle suffix-byte-range-spec', () => {
      expect(parseRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999 });
      expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    });

    it('should clamp end to file size', () => {
      expect(parseRange('bytes=0-2000', 1000)).toEqual({ start: 0, end: 999 });
      expect(parseRange('bytes=900-2000', 1000)).toEqual({ start: 900, end: 999 });
    });

    it('should return null for invalid ranges', () => {
      expect(parseRange('bytes=invalid', 1000)).toBeNull();
      expect(parseRange('notbytes=0-499', 1000)).toBeNull();
      expect(parseRange('', 1000)).toBeNull();
      expect(parseRange('bytes=', 1000)).toBeNull();
    });

    it('should return null when start > end', () => {
      expect(parseRange('bytes=500-400', 1000)).toBeNull();
    });

    it('should return null when start >= size', () => {
      expect(parseRange('bytes=1000-1500', 1000)).toBeNull();
      expect(parseRange('bytes=2000-2500', 1000)).toBeNull();
    });
  });

  describe('generatePeerId', () => {
    it('should generate a UUID-like string', () => {
      const id = generatePeerId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generatePeerId());
      }
      expect(ids.size).toBe(100);
    });
  });
});
