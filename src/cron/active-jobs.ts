import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CronActiveJobState = {
  activeJobIds: Set<string>;
  activeJobLivenessAuthoritative: boolean;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");

function getCronActiveJobState(): CronActiveJobState {
  return resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobIds: new Set<string>(),
    // After process start, activeJobIds is empty until cron startup reconciliation
    // completes. Treat liveness as non-authoritative by default so task
    // maintenance does not mark persisted cron tasks lost during the pre-start
    // window.
    activeJobLivenessAuthoritative: false,
  }));
}

export function markCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.add(jobId);
}

export function clearCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.delete(jobId);
}

export function isCronJobActive(jobId: string) {
  if (!jobId) {
    return false;
  }
  return getCronActiveJobState().activeJobIds.has(jobId);
}

export function hasActiveCronJobs() {
  return getCronActiveJobState().activeJobIds.size > 0;
}

export function markCronJobLivenessReconciling() {
  getCronActiveJobState().activeJobLivenessAuthoritative = false;
}

export function markCronJobLivenessAuthoritative() {
  getCronActiveJobState().activeJobLivenessAuthoritative = true;
}

export function isCronJobLivenessAuthoritative() {
  return getCronActiveJobState().activeJobLivenessAuthoritative;
}

export function resetCronActiveJobsForTests() {
  const state = getCronActiveJobState();
  state.activeJobIds.clear();
  state.activeJobLivenessAuthoritative = false;
}
