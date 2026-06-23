/**
 * Minimal tqdm-style progress bar for long-running CLI loops. No dependency.
 *
 * Renders in place with a carriage return on a TTY; falls back to throttled,
 * newline-terminated lines when output is piped (so logs don't get a stray \r).
 * Writes to stderr by default so it never pollutes piped stdout. Pass a known
 * `total` for a filling bar + percentage + ETA, or omit it for count-up mode.
 */

const CLEAR_EOL = "\x1b[K";

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtRate(rate: number): string {
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k/s`;
  return `${rate.toFixed(0)}/s`;
}

export interface ProgressBarOptions {
  /** Known total for a filling bar; omit for count-up mode. */
  total?: number;
  /** Bar width in chars (TTY only). */
  width?: number;
  /** Output stream (default: process.stderr). */
  stream?: NodeJS.WriteStream;
  /** Minimum ms between redraws. Defaults: 100 on a TTY, 3000 when piped. */
  minIntervalMs?: number;
}

export class ProgressBar {
  private current = 0;
  private readonly start = Date.now();
  private lastRender = 0;
  private started = false;
  private finished = false;
  private total?: number;
  private readonly stream: NodeJS.WriteStream;
  private readonly width: number;
  private readonly minIntervalMs: number;

  constructor(private readonly label: string, opts: ProgressBarOptions = {}) {
    this.total = opts.total;
    this.stream = opts.stream ?? process.stderr;
    this.width = opts.width ?? 28;
    this.minIntervalMs = opts.minIntervalMs ?? (this.stream.isTTY ? 100 : 3000);
  }

  /** Advance by `n` and redraw (throttled). */
  tick(n = 1): void {
    this.current += n;
    this.render();
  }

  private render(force = false): void {
    const now = Date.now();
    const complete = this.total != null && this.current >= this.total;
    if (!force && !complete && now - this.lastRender < this.minIntervalMs) return;
    this.lastRender = now;
    this.started = true;

    const elapsed = (now - this.start) / 1000;
    const rate = elapsed > 0 ? this.current / elapsed : 0;
    let line: string;

    if (this.total != null && this.total > 0) {
      const frac = Math.min(1, this.current / this.total);
      const filled = Math.round(frac * this.width);
      const bar = "█".repeat(filled) + "░".repeat(this.width - filled);
      const pct = `${(frac * 100).toFixed(1)}%`.padStart(6);
      const eta = rate > 0 ? (this.total - this.current) / rate : 0;
      line = `${this.label} |${bar}|${pct} ${fmtInt(this.current)}/${fmtInt(this.total)} [${fmtDuration(elapsed)}<${fmtDuration(eta)}, ${fmtRate(rate)}]`;
    } else {
      line = `${this.label} ${fmtInt(this.current)} [${fmtDuration(elapsed)}, ${fmtRate(rate)}]`;
    }

    if (this.stream.isTTY) this.stream.write(`\r${line}${CLEAR_EOL}`);
    else this.stream.write(`${line}\n`);
  }

  /** Final redraw + newline. No-op if never ticked or already done. */
  done(): void {
    if (this.finished || !this.started) return;
    this.finished = true;
    this.render(true);
    if (this.stream.isTTY) this.stream.write("\n");
  }
}
