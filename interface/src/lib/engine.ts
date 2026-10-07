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
    throw new Error(`submit attempt failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}
