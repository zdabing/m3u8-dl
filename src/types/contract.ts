/** Shared REST/WebSocket data, free of server dependencies. */
export type TaskStatus = 'pause' | 'resume' | 'done' | 'pending' | 'error';
export type TaskPhase = 'queued' | 'parsing' | 'downloading' | 'merging' | 'done';
export type SegmentStatus = 'pending' | 'downloading' | 'done' | 'error';
export interface SegmentProgress {
  index: number;
  status: SegmentStatus;
  size: number;
  attempts: number;
  error?: string;
}
export interface SegmentSnapshot {
  fingerprint: string;
  items: SegmentProgress[];
}
export interface DownloadStats {
  startTime?: number;
  endTime?: number;
  progress?: number;
  phase?: TaskPhase;
  mergeProgress?: number;
  mergeMessage?: string;
  tsCount?: number;
  tsSuccess?: number;
  tsFailed?: number;
  hasSegmentDetails?: boolean;
  duration?: number;
  size?: number;
  downloadedSize?: number;
  speed?: number;
  speedDesc?: string;
  remainingTime?: number;
  localVideo?: string;
  filename?: string;
  threadNum?: number;
  errmsg?: string;
}
export interface TaskOptions {
  filename?: string;
  saveDir?: string;
  ignoreSegments?: string;
  headers?: string | Record<string, string | string[] | number | undefined>;
}
export interface TaskItem extends DownloadStats {
  url: string;
  status: TaskStatus;
  cacheDir?: string;
  options?: TaskOptions;
  dlOptions?: TaskOptions;
}
export interface QueueStatus {
  queueLength: number;
  activeDownloads: string[];
  maxConcurrent: number;
}
export interface ServerInfo {
  version: string;
}
export interface ServerConfig {
  threadNum: number;
  saveDir: string;
  delCache: boolean;
  maxDownloads: number;
  ffmpegPath: string;
  headers: string;
  mergeTimeout: number;
  proxyMode: 'custom' | 'system' | 'disabled';
  proxyUrl: string;
  noProxy: string;
}
export interface ApiResponse<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}
