export interface RateLimitState {
  windowSecond: number;
  count: number;
}

export function newRateLimitState(nowMs: number): RateLimitState {
  return { windowSecond: Math.floor(nowMs / 1000), count: 0 };
}

export function consume(state: RateLimitState, nowMs: number, limitPerSec: number): boolean {
  const second = Math.floor(nowMs / 1000);
  if (second !== state.windowSecond) {
    state.windowSecond = second;
    state.count = 0;
  }
  if (state.count >= limitPerSec) return false;
  state.count++;
  return true;
}
