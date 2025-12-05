import { EventEmitter } from 'events';
import { TransferProgress } from '../types';

/**
 * Transfer Progress Tracker
 * Manages progress tracking and event emission for file transfers
 */
export class TransferProgressTracker extends EventEmitter {
  private startTime: number;
  private startByte: number;

  constructor(startByte: number = 0) {
    super();
    this.startTime = Date.now();
    this.startByte = startByte;
  }

  /**
   * Calculate and emit progress
   */
  emitProgress(
    fileId: string,
    fileName: string,
    transferred: number,
    total: number
  ): void {
    const elapsed = Date.now() - this.startTime;
    const actualTransferred = transferred - this.startByte;
    
    const progress: TransferProgress = {
      fileId,
      fileName,
      transferred,
      total,
      percentage: (transferred / total) * 100,
      speed: elapsed > 0 ? (actualTransferred / elapsed) * 1000 : 0,
      eta: this.calculateEta(actualTransferred, total - transferred, elapsed),
    };

    this.emit('progress', progress);
  }

  /**
   * Calculate estimated time remaining
   */
  private calculateEta(transferred: number, remaining: number, elapsed: number): number {
    if (transferred === 0 || elapsed === 0) {
      return Infinity;
    }
    const speed = (transferred / elapsed) * 1000; // bytes per second
    return remaining / speed;
  }

  /**
   * Reset the tracker for a new transfer
   */
  reset(startByte: number = 0): void {
    this.startTime = Date.now();
    this.startByte = startByte;
  }
}
