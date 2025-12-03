/**
 * Core type definitions and interfaces for Easy-Share
 */

/** Transfer mode */
export enum TransferMode {
  LAN = 'lan',
  WAN = 'wan',
  AUTO = 'auto',
}

/** Transfer status */
export enum TransferStatus {
  IDLE = 'idle',
  DISCOVERING = 'discovering',
  CONNECTING = 'connecting',
  TRANSFERRING = 'transferring',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/** File metadata */
export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  mimeType?: string;
  path?: string;
}

/** Peer information */
export interface PeerInfo {
  id: string;
  name: string;
  address?: string;
  port?: number;
  mode: TransferMode;
}

/** Discovery service information (mDNS) */
export interface ServiceInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  txt?: Record<string, string>;
}

/** Transfer progress event */
export interface TransferProgress {
  fileId: string;
  fileName: string;
  transferred: number;
  total: number;
  percentage: number;
  speed: number; // bytes per second
  eta: number; // estimated time remaining in seconds
}

/** Signaling message types */
export enum SignalType {
  ROOM_CREATE = 'room:create',
  ROOM_CREATED = 'room:created',
  ROOM_JOIN = 'room:join',
  ROOM_JOINED = 'room:joined',
  SIGNAL = 'signal',
  ERROR = 'error',
  FILE_INFO = 'file:info',
  FILE_REQUEST = 'file:request',
}

/** Signaling message payload */
export interface SignalMessage {
  type: SignalType;
  payload: unknown;
  timestamp?: number;
}

/** WebRTC signal data */
export interface SignalData {
  type?: string;
  sdp?: string;
  candidate?: unknown; // RTCIceCandidate
}

/** Room information */
export interface RoomInfo {
  roomId: string;
  createdAt: number;
  peers: string[];
}

/** Stream proxy configuration */
export interface ProxyConfig {
  port: number;
  host?: string;
}

/** File read request (for range support) */
export interface FileReadRequest {
  fileId: string;
  start: number;
  length: number;
}

/** File chunk response */
export interface FileChunkResponse {
  fileId: string;
  start: number;
  data: ArrayBuffer;
  isLast: boolean;
}

/** Transfer options */
export interface TransferOptions {
  mode?: TransferMode;
  chunkSize?: number;
  timeout?: number;
  retries?: number;
  signal?: unknown; // AbortSignal
}

/** Verification code information */
export interface VerificationInfo {
  code: string;
  expiresAt: number;
  verified: boolean;
}

/** Verification request */
export interface VerificationRequest {
  code: string;
}

/** Verification response */
export interface VerificationResponse {
  success: boolean;
  message?: string;
  sessionToken?: string;
}

/** Event callback types */
export type ProgressCallback = (progress: TransferProgress) => void;
export type StatusCallback = (status: TransferStatus) => void;
export type ErrorCallback = (error: Error) => void;

/** Configuration for the core library */
export interface CoreConfig {
  signalingServer?: string;
  stunServers?: string[];
  turnServers?: unknown[]; // RTCIceServer[]
  discoveryTimeout?: number;
  defaultChunkSize?: number;
}
