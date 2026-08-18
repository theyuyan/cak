import type { KernelError, KernelErrorCode, KernelErrorInit, JsonObject } from '../sdk/types.js';
import { randomUUID } from 'node:crypto';

export class KernelErr extends Error implements KernelError {
  readonly id: string; readonly at: string; readonly code: KernelErrorCode; readonly retryable?: boolean; readonly detail?: JsonObject; readonly taskId?: string;
  constructor(init: KernelErrorInit & { taskId?: string }) {
    super(init.message);
    this.name = 'KernelErr'; this.id = 'err_' + randomUUID().slice(0, 12); this.at = new Date().toISOString();
    this.code = init.code; this.retryable = init.retryable; this.detail = init.detail; this.taskId = init.taskId;
  }
  toJSON(): KernelError { return { id: this.id, at: this.at, code: this.code, message: this.message, retryable: this.retryable, detail: this.detail, taskId: this.taskId }; }
}
export const err = (code: KernelErrorCode, message: string, extra: Partial<KernelErrorInit> = {}) => new KernelErr({ code, message, ...extra });
export const toErrorInit = (e: unknown): KernelErrorInit =>
  e instanceof KernelErr ? { code: e.code, message: e.message, retryable: e.retryable, detail: e.detail }
  : { code: 'PROVIDER_ERROR', message: e instanceof Error ? e.message : String(e), retryable: false };
