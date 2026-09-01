// Idempotency key management.
//
// A key has a stable lifecycle:
//   generateIdempotencyKey("job-create") -> UUID     // generates once
//   retry uses same key (because key is held in caller scope)
//   clearIdempotencyKey("job-create")    -> delete   // on mutation success/final-fail
//
// The previous implementation used a module-level Map that never expired,
// leaking keys indefinitely. The new approach is intentionally tiny: the
// caller owns the key (typically a React Query mutation function holds it in
// a closure across retry attempts). The store is here only as a fallback
// for callers that genuinely want cross-call reuse by stable action ID,
// and it bounds itself to prevent runaway memory growth.

const MAX_TRACKED_KEYS = 1000;
const keyStore = new Map<string, string>();

function evictIfFull(): void {
  if (keyStore.size <= MAX_TRACKED_KEYS) return;
  // Drop oldest entries first (Map iteration order is insertion order).
  const overflow = keyStore.size - MAX_TRACKED_KEYS;
  let i = 0;
  for (const k of keyStore.keys()) {
    if (i >= overflow) break;
    keyStore.delete(k);
    i++;
  }
}

/**
 * Generate (or reuse) an idempotency key for the given stable action ID.
 * Safe to call multiple times for the same actionId — returns the same key.
 */
export function generateIdempotencyKey(actionId: string): string {
  const existing = keyStore.get(actionId);
  if (existing) return existing;
  const key = crypto.randomUUID();
  keyStore.set(actionId, key);
  evictIfFull();
  return key;
}

/** Generate a one-shot idempotency key NOT bound to a stable action ID.
 *  This is the preferred API for React Query mutations — generate at the
 *  start of the mutation function, hold in closure across retries, clear
 *  on success or final failure. */
export function newIdempotencyKey(scope: string): string {
  const id = crypto.randomUUID();
  return `${scope}:${id}`;
}

export function getIdempotencyKey(actionId: string): string | undefined {
  return keyStore.get(actionId);
}

export function clearIdempotencyKey(actionId: string): void {
  keyStore.delete(actionId);
}

/** Clear ALL tracked keys. Intended for tests + explicit log-out flows. */
export function clearAllIdempotencyKeys(): void {
  keyStore.clear();
}