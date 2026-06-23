/**
 * Live per-stream level meter (PRD-1). Pure presentation: the linear peak in
 * [0, 1] is owned by the capture controller (one independent meter per source,
 * mic vs system — they never share a value).
 *
 * The bar width maps the linear peak through a light perceptual curve so quiet
 * speech is still visible; the numeric dBFS is shown for precision.
 */
import type { AudioSource } from "@loqui/shared";

export interface CaptureLevelMeterProps {
  source: AudioSource;
  /** Linear peak in [0, 1]. */
  level: number;
  /** Whether this source is actively capturing (drives the active styling). */
  active: boolean;
}

const LABEL: Record<AudioSource, string> = {
  mic: "You (mic)",
  system: "They (system)",
};

function toDbfs(level: number): string {
  if (level <= 0) return "-∞";
  const db = 20 * Math.log10(level);
  return `${db <= -60 ? "-60" : db.toFixed(0)} dBFS`;
}

export function CaptureLevelMeter({
  source,
  level,
  active,
}: CaptureLevelMeterProps): JSX.Element {
  const clamped = Math.max(0, Math.min(1, level));
  // Perceptual-ish curve so low-level speech is visible.
  const pct = Math.round(Math.sqrt(clamped) * 100);
  return (
    <div
      className={`meter meter--${source} ${active ? "meter--active" : ""}`}
      data-testid={`level-meter-${source}`}
      data-active={active}
      data-level={clamped.toFixed(3)}
    >
      <div className="meter__head">
        <span className="meter__label">{LABEL[source]}</span>
        <span className="meter__db">{active ? toDbfs(clamped) : "—"}</span>
      </div>
      <div
        className="meter__track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${LABEL[source]} level`}
      >
        <div className="meter__fill" style={{ width: `${active ? pct : 0}%` }} />
      </div>
    </div>
  );
}
