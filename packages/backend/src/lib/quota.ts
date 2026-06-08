export interface KvUsage {
  totalBytes: number;
  keyCount: number;
  existingKeyBytes: number;
  keyExists: boolean;
}

export interface KvLimits {
  maxValueBytes: number;
  maxTotalBytesPerUser: number;
  maxKeysPerUser: number;
}

export type QuotaCheck = { ok: true } | { ok: false; reason: string };

export function checkKvWrite(usage: KvUsage, newValueBytes: number, limits: KvLimits): QuotaCheck {
  if (newValueBytes > limits.maxValueBytes) {
    return { ok: false, reason: `value exceeds ${limits.maxValueBytes} bytes` };
  }
  const projectedTotal = usage.totalBytes - usage.existingKeyBytes + newValueBytes;
  if (projectedTotal > limits.maxTotalBytesPerUser) {
    return { ok: false, reason: 'per-user kv quota exceeded' };
  }
  if (!usage.keyExists && usage.keyCount >= limits.maxKeysPerUser) {
    return { ok: false, reason: `per-user key count limit (${limits.maxKeysPerUser}) exceeded` };
  }
  return { ok: true };
}

/** Pro tier: 10 MB/user, 1000 keys, 64 KB/value. */
export const KV_LIMITS: KvLimits = {
  maxValueBytes: 64 * 1024,
  maxTotalBytesPerUser: 10 * 1024 * 1024,
  maxKeysPerUser: 1000,
};
