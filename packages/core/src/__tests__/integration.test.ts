import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatSpeed,
  formatTime,
  getMimeType,
  generatePeerId,
  generateRoomCode,
  getFileExtension,
  parseRange,
} from '../utils';

describe('Integration Tests - Utilities', () => {
  describe('File Operations', () => {
    it('should handle complete file info workflow', () => {
      const filename = 'test-video.mp4';
      const ext = getFileExtension(filename);
      const mimeType = getMimeType(filename);
      const fileSize = 1073741824; // 1 GB

      expect(ext).toBe('mp4');
      expect(mimeType).toBe('video/mp4');
      expect(formatBytes(fileSize)).toBe('1.00 GB');
    });

    it('should generate unique identifiers', () => {
      const peerId1 = generatePeerId();
      const peerId2 = generatePeerId();
      const roomCode1 = generateRoomCode();
      const roomCode2 = generateRoomCode();

      expect(peerId1).not.toBe(peerId2);
      expect(roomCode1).not.toBe(roomCode2);
      expect(roomCode1).toMatch(/^\d{6}$/);
      expect(roomCode2).toMatch(/^\d{6}$/);
    });
  });

  describe('Transfer Progress Formatting', () => {
    it('should format transfer progress information', () => {
      const totalBytes = 104857600; // 100 MB
      const transferredBytes = 52428800; // 50 MB
      const timeElapsed = 10; // 10 seconds
      const bytesPerSecond = transferredBytes / timeElapsed;
      const timeRemaining = (totalBytes - transferredBytes) / bytesPerSecond;

      const totalFormatted = formatBytes(totalBytes);
      const transferredFormatted = formatBytes(transferredBytes);
      const speedFormatted = formatSpeed(bytesPerSecond);
      const etaFormatted = formatTime(timeRemaining);

      expect(totalFormatted).toBe('100.00 MB');
      expect(transferredFormatted).toBe('50.00 MB');
      expect(speedFormatted).toContain('MB/s');
      expect(etaFormatted).toBe('10s');
    });

    it('should handle edge cases in time formatting', () => {
      expect(formatTime(0)).toBe('0s');
      expect(formatTime(59)).toBe('59s');
      expect(formatTime(60)).toBe('1m 0s');
      expect(formatTime(3599)).toBe('59m 59s');
      expect(formatTime(3600)).toBe('1h 0m 0s');
      expect(formatTime(Infinity)).toBe('--');
      expect(formatTime(-1)).toBe('--');
    });
  });

  describe('Range Request Handling', () => {
    const fileSize = 1000000; // 1 MB

    it('should handle complete range request workflow', () => {
      // Client requests first 500KB
      const rangeHeader = 'bytes=0-499999';
      const range = parseRange(rangeHeader, fileSize);

      expect(range).not.toBeNull();
      expect(range!.start).toBe(0);
      expect(range!.end).toBe(499999);

      // Calculate chunk size
      const chunkSize = range!.end - range!.start + 1;
      expect(chunkSize).toBe(500000);
    });

    it('should handle resume download scenario', () => {
      // Client already has first 300KB, requests rest
      const rangeHeader = 'bytes=300000-';
      const range = parseRange(rangeHeader, fileSize);

      expect(range).not.toBeNull();
      expect(range!.start).toBe(300000);
      expect(range!.end).toBe(fileSize - 1);

      // Calculate remaining bytes
      const remaining = range!.end - range!.start + 1;
      expect(remaining).toBe(700000);
    });

    it('should handle tail request (last N bytes)', () => {
      // Client requests last 100KB
      const rangeHeader = 'bytes=-100000';
      const range = parseRange(rangeHeader, fileSize);

      expect(range).not.toBeNull();
      expect(range!.start).toBe(900000);
      expect(range!.end).toBe(fileSize - 1);

      const chunkSize = range!.end - range!.start + 1;
      expect(chunkSize).toBe(100000);
    });
  });

  describe('MIME Type Detection', () => {
    it('should detect video streaming MIME types', () => {
      const videoFiles = [
        { name: 'movie.mp4', mime: 'video/mp4' },
        { name: 'series.mkv', mime: 'video/x-matroska' },
        { name: 'clip.webm', mime: 'video/webm' },
        { name: 'old-movie.avi', mime: 'video/x-msvideo' },
      ];

      videoFiles.forEach(({ name, mime }) => {
        expect(getMimeType(name)).toBe(mime);
      });
    });

    it('should detect common document MIME types', () => {
      const docFiles = [
        { name: 'report.pdf', mime: 'application/pdf' },
        { name: 'document.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        { name: 'spreadsheet.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { name: 'readme.txt', mime: 'text/plain' },
      ];

      docFiles.forEach(({ name, mime }) => {
        expect(getMimeType(name)).toBe(mime);
      });
    });
  });

  describe('Room Code Generation', () => {
    it('should generate valid 6-digit codes', () => {
      const codes = new Set<string>();
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const code = generateRoomCode();
        expect(code).toMatch(/^\d{6}$/);
        expect(parseInt(code, 10)).toBeGreaterThanOrEqual(100000);
        expect(parseInt(code, 10)).toBeLessThanOrEqual(999999);
        codes.add(code);
      }

      // Should have high uniqueness (at least 95% unique)
      expect(codes.size).toBeGreaterThan(iterations * 0.95);
    });
  });
});
