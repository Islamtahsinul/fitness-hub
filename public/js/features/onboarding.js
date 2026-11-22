// First-run state (pure, no DOM). Stored in the user data as data.ui.onboarding so it follows
// the data file, not the browser: {version, completed_at, skipped_at, safety_ack_at} (ISO times).

export const ONBOARDING_VERSION = 1;
export const WELCOME_STEPS = ['welcome', 'profile', 'start', 'clearance', 'safety'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function onboardingState(data) {
  const o = data?.ui?.onboarding;
  return isObj(o) ? o : null;
}

/** True until the welcome has been finished or skipped once. */
export function needsOnboarding(data) {
  const o = onboardingState(data);
  return !(o && (o.completed_at || o.skipped_at));
}

/** Records the outcome in place and returns the new state. */
export function markOnboarding(data, { skipped = false, safetyAck = false, now = new Date().toISOString() } = {}) {
  data.ui = isObj(data.ui) ? data.ui : {};
  const o = { ...(onboardingState(data) || {}), version: ONBOARDING_VERSION };
  if (skipped) o.skipped_at = o.skipped_at || now;
  else o.completed_at = now;
  if (safetyAck) o.safety_ack_at = now;
  data.ui.onboarding = o;
  return o;
}

/** Step index (0-based) from a route parameter such as "3" (1-based); clamps to the range. */
export function stepFromParam(param) {
  const n = Math.floor(Number(param));
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(n, WELCOME_STEPS.length) - 1;
}
