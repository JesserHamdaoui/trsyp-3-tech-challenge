import type { GameParams, NumericParamKey } from "@/lib/pianoGame";

/** Where each setting sits between its easiest (1) and hardest (5) value, in plain words. */
export interface Scale {
  easy: number;
  hard: number;
  words: [string, string, string, string, string];
}

const SCALE: Record<NumericParamKey, Scale> = {
  targetCurlThreshold: { easy: 0.5, hard: 0.8, words: ["Tiny bend", "Small bend", "Medium bend", "Big bend", "Full fist"] },
  isolationTolerance: { easy: 0.5, hard: 0.2, words: ["Fingers can wander", "Relaxed", "Balanced", "Strict", "Fully isolated"] },
  timingWindowMs: { easy: 500, hard: 200, words: ["Very generous", "Generous", "Normal", "Tight", "Very tight"] },
  noteFallMs: { easy: 2600, hard: 1100, words: ["Very slow", "Slow", "Medium", "Fast", "Very fast"] },
  sequenceLength: { easy: 8, hard: 30, words: ["Very short", "Short", "Medium", "Long", "Very long"] },
};

export function scaleLevel(s: Scale, value: number): number {
  const t = (value - s.easy) / (s.hard - s.easy);
  return Math.min(5, Math.max(1, Math.round(1 + 4 * t)));
}

export function levelFor(key: NumericParamKey, value: number): number {
  return scaleLevel(SCALE[key], value);
}

export function wordFor(key: NumericParamKey, value: number): string {
  return SCALE[key].words[levelFor(key, value) - 1];
}

/** A setting as a read-only slider: the knob sits between easier and harder. A ghost knob marks where it was before a change. */
export function Meter({ scale, value, from }: { scale: Scale; value: number; from?: number }) {
  const level = scaleLevel(scale, value);
  const word = scale.words[level - 1];
  const prev = from !== undefined && scaleLevel(scale, from) !== level ? scaleLevel(scale, from) : null;
  const at = (l: number) => `${((l - 1) / 4) * 100}%`;
  return (
    <div className="setting-meter" title={String(value)}>
      <span className="setting-word">{word}</span>
      <div
        className="slider"
        role="slider"
        aria-readonly="true"
        aria-label={word}
        aria-valuemin={1}
        aria-valuemax={5}
        aria-valuenow={level}
        aria-valuetext={word}
      >
        <div className="slider-track">
          <i className="slider-fill" style={{ width: at(level) }} />
          {[0, 1, 2, 3, 4].map((n) => (
            <b key={n} className="slider-dot" data-passed={n + 1 <= level} style={{ left: `${n * 25}%` }} />
          ))}
        </div>
        {prev !== null && <span className="slider-thumb ghost" style={{ left: at(prev) }} />}
        <span className="slider-thumb" style={{ left: at(level) }} />
      </div>
      <div className="slider-ends" aria-hidden>
        <span>Easier</span>
        <span>Harder</span>
      </div>
    </div>
  );
}

export default function SettingMeter({ k, value, from }: { k: NumericParamKey; value: number; from?: number }) {
  return <Meter scale={SCALE[k]} value={value} from={from} />;
}

export type { GameParams };
