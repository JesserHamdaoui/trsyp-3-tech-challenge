import type { FrameRecord } from "@/lib/handFeatures";

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL!;

export async function submitAttemptBatch(
  accessToken: string,
  exerciseId: string,
  frames: FrameRecord[],
  meta: Record<string, unknown> = {}
) {
  const resp = await fetch(`${ENGINE_URL}/attempts/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ exercise_id: exerciseId, is_idealized: false, frames, meta }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail ?? `submit attempt failed: ${resp.status}`);
  }
  return resp.json();
}

export async function inviteUser(accessToken: string, email: string, role: string, fullName: string = "") {
  const resp = await fetch(`${ENGINE_URL}/auth/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ email, role, full_name: fullName }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail ?? `invite failed: ${resp.status}`);
  }
  return resp.json() as Promise<{ email: string; role: string; invited_by: string }>;
}

export interface Exercise {
  id: number;
  exercise_id: string;
  display_name: string;
  description: string;
}

export async function listExercises(): Promise<Exercise[]> {
  const resp = await fetch(`${ENGINE_URL}/exercises`);
  if (!resp.ok) throw new Error(`could not load exercises: ${resp.status}`);
  return resp.json();
}

/** Admin-only: stores a demonstrator attempt (patient_id stays null) used as the exercise's reference. */
export async function submitReferenceAttempt(
  accessToken: string,
  exerciseId: string,
  frames: unknown[],
  meta: Record<string, unknown> = {}
) {
  const resp = await fetch(`${ENGINE_URL}/attempts/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ exercise_id: exerciseId, is_idealized: true, frames, meta }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail ?? `upload failed: ${resp.status}`);
  }
  return resp.json() as Promise<{ id: number; exercise_id: string }>;
}

export interface QualityReport {
  verdict: "good" | "review" | "poor";
  issues: string[];
  frame_count: number;
  detected_frames: number;
  detection_rate: number;
  duration_ms: number | null;
  fps: number | null;
  target_finger: string | null;
  target_peak_curl: number | null;
  isolation_peak: number | null;
  accuracy: number | null;
}

export interface ReferenceSummary {
  id: number;
  exercise_id: string;
  created_at: string;
  frame_count: number;
  meta: Record<string, unknown>;
  quality: QualityReport;
}

/**
 * An invitee can end up signed in without a profile row (the accept-invite step
 * was skipped or failed), which makes every call 401. The invite metadata is
 * enough to create it, so do that once and let the caller retry.
 */
async function ensureProfile(accessToken: string): Promise<boolean> {
  const resp = await fetch(`${ENGINE_URL}/auth/complete-profile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return resp.ok || resp.status === 409;
}

async function authed<T>(accessToken: string, path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const resp = await fetch(`${ENGINE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...init.headers },
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    if (resp.status === 401 && !retried && (await ensureProfile(accessToken).catch(() => false))) {
      return authed<T>(accessToken, path, init, true);
    }
    throw new Error(body.detail ?? `request failed: ${resp.status}`);
  }
  return resp.json();
}

export const listReferences = (accessToken: string) =>
  authed<ReferenceSummary[]>(accessToken, "/attempts/references");

export const deleteReferences = (accessToken: string, ids: number[]) =>
  authed<{ deleted: number }>(accessToken, "/attempts/references/delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });

/** Full attempt incl. frames -- used to export a reference as a JSON file. */
export const getAttempt = (accessToken: string, id: number) =>
  authed<{ id: number; exercise_id: string; frames: unknown[]; meta: Record<string, unknown> }>(
    accessToken,
    `/attempts/${id}`
  );

export interface AnalyticsOverview {
  days: number;
  totals: {
    patients: number;
    physiatrists: number;
    admins: number;
    exercises: number;
    prescriptions: number;
    assignments: number;
    attempts: number;
    references: number;
  };
  active_patients: number;
  adherence_rate: number | null;
  prescriptions_started: number;
  avg_accuracy: number | null;
  outcomes: { hits: number; leaks: number; misses: number };
  by_day: { date: string; attempts: number; avg_accuracy: number | null }[];
  by_exercise: {
    exercise_id: string;
    display_name: string;
    prescriptions: number;
    patients_played: number;
    attempts: number;
    avg_accuracy: number | null;
    avg_score: number | null;
  }[];
  by_physiatrist: {
    id: string;
    name: string;
    patients: number;
    prescriptions: number;
    patient_attempts: number;
    active_patients: number;
  }[];
}

export const getAnalyticsOverview = (accessToken: string, days: number) =>
  authed<AnalyticsOverview>(accessToken, `/analytics/overview?days=${days}`);

export interface Me {
  id: string;
  email: string;
  role: "admin" | "patient" | "physiatrist";
  full_name: string;
}

export const getMe = (accessToken: string) => authed<Me>(accessToken, "/auth/me");

export const updateMyName = (accessToken: string, fullName: string) =>
  authed<Me>(accessToken, "/auth/me", { method: "PATCH", body: JSON.stringify({ full_name: fullName }) });

export interface TeamMember {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "physiatrist";
  status: "active" | "pending";
  invited_at: string | null;
}

export const listTeam = (accessToken: string, role: TeamMember["role"]) =>
  authed<TeamMember[]>(accessToken, `/auth/team?role=${role}`);

export const removeTeamMember = (accessToken: string, id: string) =>
  authed<{ deleted: string }>(accessToken, `/auth/team/${id}`, { method: "DELETE" });

export interface PatientRecord {
  id: string;
  email: string;
  full_name: string;
  joined_at: string;
  last_sign_in_at: string | null;
  suspended: boolean;
  physiatrists: { id: string; name: string }[];
  prescribed_exercises: string[];
  rounds: number;
  last_round_at: string | null;
  active_days_30: number;
  avg_accuracy: number | null;
}

export const listPatients = (accessToken: string) => authed<PatientRecord[]>(accessToken, "/auth/patients");

export const setPatientAccess = (accessToken: string, id: string, suspended: boolean) =>
  authed<{ id: string; name: string }>(accessToken, `/auth/patients/${id}/access`, {
    method: "POST",
    body: JSON.stringify({ suspended }),
  });

export interface AttemptHistoryItem {
  id: number;
  exercise_id: string;
  created_at: string;
  meta: Record<string, unknown>;
}

export const getAttemptHistory = (accessToken: string, exerciseId: string, limit = 10) =>
  authed<AttemptHistoryItem[]>(
    accessToken,
    `/attempts/history?exercise_id=${encodeURIComponent(exerciseId)}&limit=${limit}`
  );

export interface AnalysisDriver {
  key: string;
  finger: string;
  metric: string;
  label: string;
  detail: string;
  value: number;
  reference: number;
  z: number;
  share: number;
}

export interface AnalysisFinger {
  finger: string;
  badness: number;
  peak_curl: number | null;
  leak: number | null;
  latency_ms: number | null;
  clean_rate: number | null;
  /** every per-finger metric the game measures, by name (Pinch Flight uses these) */
  values?: Record<string, number>;
}

export interface FeatureDelta {
  key: string;
  label: string;
  finger: string;
  before: number;
  after: number;
  better: boolean;
  magnitude: number;
}

export interface AnalysisChange {
  key: string;
  label: string;
  from_value: number | string | null;
  to_value: number | string | null;
  direction: "harder" | "easier";
  reason: string;
}

export interface Adaptation {
  verdict: "harder" | "easier" | "hold";
  rationale: string;
  confidence: number;
  quality: number | null;
  focus_finger: string | null;
  current_params: Record<string, unknown>;
  next_params: Record<string, unknown>;
  changes: AnalysisChange[];
}

export interface Analysis {
  attempt_id: number | null;
  exercise_id: string;
  accuracy: number | null;
  deviation_score: number | null;
  detection_rate: number | null;
  features: Record<string, number>;
  reference: { source: "idealized" | "prior"; attempts: number };
  drivers: AnalysisDriver[];
  fingers: AnalysisFinger[];
  previous: {
    attempt_id: number;
    accuracy: number | null;
    score: number | null;
    deviation_score: number | null;
    accuracy_delta: number | null;
    score_delta: number | null;
    deviation_delta: number | null;
    improved: FeatureDelta[];
    regressed: FeatureDelta[];
  } | null;
  trend: {
    attempts: number;
    direction: "improving" | "declining" | "plateau" | "building";
    accuracy_level: number | null;
    accuracy_slope: number | null;
    deviation_level: number | null;
    volatility: number;
    best_accuracy: number | null;
    accuracy_series: number[];
    deviation_series: number[];
  };
  adaptation: Adaptation | null;
}

/** Engine analysis of a stored attempt: deviation from the idealized reference, vs previous, trend, adaptation. */
export const getAttemptAnalysis = (accessToken: string, id: number) =>
  authed<Analysis>(accessToken, `/attempts/${id}/analysis`);

/** Same analysis for frames that are not stored (admin practice run). */
export const analyzeAttempt = (accessToken: string, exerciseId: string, frames: unknown[], meta: Record<string, unknown>) =>
  authed<Analysis>(accessToken, "/attempts/analyze", {
    method: "POST",
    body: JSON.stringify({ exercise_id: exerciseId, frames, meta }),
  });

/** Analysis of the patient's latest attempt (null before the first); `adaptation.next_params` starts the next round. */
export const getNextParams = (accessToken: string, exerciseId: string) =>
  authed<Analysis | null>(accessToken, `/attempts/next-params?exercise_id=${encodeURIComponent(exerciseId)}`);

// ---- physiatrist ("care") dashboards ----

export interface CareReason {
  code: string;
  text: string;
  severity: "high" | "medium" | "low";
}

export interface CarePatient {
  id: string;
  email: string;
  full_name: string;
  assigned_at: string;
  status: "needs_attention" | "on_track" | "new";
  reasons: CareReason[];
  trend: "improving" | "declining" | "plateau" | "building";
  prescriptions: string[];
  prescription_ids: Record<string, number>;
  rounds: number;
  rounds_7d: number;
  last_round_at: string | null;
  recent_accuracy: number | null;
  avg_accuracy: number | null;
}

export interface CareOverview {
  days: number;
  patients: number;
  active_patients: number;
  needs_attention: number;
  adherence_rate: number | null;
  avg_accuracy: number | null;
  rounds: number;
  by_day: { date: string; attempts: number; avg_accuracy: number | null }[];
  attention: CarePatient[];
  movers: { id: string; name: string; from_accuracy: number; to_accuracy: number }[];
  outcomes: { hits: number; leaks: number; misses: number };
}

export interface CareAttempt {
  id: number;
  exercise_id: string;
  created_at: string;
  accuracy: number | null;
  score: number | null;
  hits: number | null;
  leaks: number | null;
  misses: number | null;
  params: Record<string, unknown> | null;
}

export interface CarePrescription {
  id: number;
  exercise_id: string;
  display_name: string;
  assigned_at: string;
  rounds: number;
  last_round_at: string | null;
  avg_accuracy: number | null;
  /** hand the physiatrist fixed for this game; null = the patient is asked each round */
  hand: Hand | null;
}

export type Hand = "left" | "right";

export interface CarePatientDetail {
  summary: CarePatient;
  prescriptions: CarePrescription[];
  attempts: CareAttempt[];
  latest_analysis: Analysis | null;
}

export const getCareOverview = (accessToken: string, days = 30) =>
  authed<CareOverview>(accessToken, `/care/overview?days=${days}`);

export const listCarePatients = (accessToken: string) => authed<CarePatient[]>(accessToken, "/care/patients");

export const getCarePatient = (accessToken: string, id: string) =>
  authed<CarePatientDetail>(accessToken, `/care/patients/${id}`);

export const unassignPatient = (accessToken: string, id: string) =>
  authed<{ unassigned: boolean }>(accessToken, `/care/patients/${id}`, { method: "DELETE" });

export const prescribeExercise = (accessToken: string, patientId: string, exerciseId: string) =>
  authed<{ id: number }>(accessToken, "/prescriptions", {
    method: "POST",
    body: JSON.stringify({ patient_id: patientId, exercise_id: exerciseId }),
  });

export const removePrescription = (accessToken: string, prescriptionId: number) =>
  authed<{ removed: boolean }>(accessToken, `/prescriptions/${prescriptionId}`, { method: "DELETE" });

export interface MyPrescription {
  id: number;
  exercise_id: string;
  hand: Hand | null;
}

/** Fixes the hand a patient trains with for a prescription; null clears it (the patient is asked). */
export const setPrescriptionHand = (accessToken: string, prescriptionId: number, hand: Hand | null) =>
  authed<{ id: number }>(accessToken, `/prescriptions/${prescriptionId}/hand`, { method: "PATCH", body: JSON.stringify({ hand }) });

/** The exercises prescribed to the signed-in patient. */
export const listMyExercises = (accessToken: string) => authed<MyPrescription[]>(accessToken, "/prescriptions/my-exercises");
