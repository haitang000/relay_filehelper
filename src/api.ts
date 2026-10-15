export type User = { id: string; username: string };
export type Room = { id: string; name: string; code: string; adminId: string; isAdmin: boolean; ttlHours: number; createdAt: number; memberCount: number; usedBytes: number; quotaBytes: number };
export type Member = User & { joinedAt: number };
export type SharedFile = { id: string; name: string; size: number; audience: 'all' | 'selected'; createdAt: number; expiresAt: number; senderId: string; senderName: string; recipients: User[] };
export type FilePage = { files: SharedFile[]; total: number; page: number; pageSize: number };
export type Config = { registrationEnabled: boolean; maxFileBytes: number; maxBatchFiles: number; maxConcurrentUploads: number; roomQuotaBytes: number; totalQuotaBytes: number };
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(body.error ?? '请求失败，请稍后重试', response.status);
  }
  return body;
}
export const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
export function upload(roomId: string, file: File, audience: 'all' | 'selected', recipients: string[], onProgress: (progress: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${roomId}/files?${new URLSearchParams({ audience, recipients: recipients.join(',') })}`);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    const done = () => signal.removeEventListener('abort', abort);
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(100); resolve(); }
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event('session-expired'));
        let message = '上传失败，请重试';
        try { message = JSON.parse(xhr.responseText).error ?? message; } catch { /* Proxy may return HTML. */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => { done(); reject(new Error('网络连接中断，请重试')); };
    xhr.onabort = () => { done(); reject(new Error('上传已取消')); };
    if (signal.aborted) { reject(new Error('上传已取消')); return; }
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
export function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / 1024 ** i).toFixed(i < 2 ? 0 : 1))} ${units[i]}`;
}
export const ttlLabel = (hours: number) => hours <= 24 ? `${hours} 小时` : `${hours / 24} 天`;
export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
