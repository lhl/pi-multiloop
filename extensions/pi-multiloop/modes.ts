import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type LoopMode = "optimize" | "punchlist" | "research" | "dev";

export interface ModeConfig {
  name: LoopMode;
  description: string;
  hasKeepRevert: boolean;
  hasMetric: boolean;
  defaultDirection: "lower" | "higher";
  defaultAcceptanceMode: "log" | "keep-revert";
  convergenceCheck: string;
}

export const MODES: Record<LoopMode, ModeConfig> = {
  optimize: {
    name: "optimize",
    description: "Edit → measure → keep if improved, revert if not → repeat",
    hasKeepRevert: true,
    hasMetric: true,
    defaultDirection: "lower",
    defaultAcceptanceMode: "keep-revert",
    convergenceCheck: "Metric threshold, budget, or plateau",
  },
  punchlist: {
    name: "punchlist",
    description: "Pick next unchecked item → implement → verify → check off",
    hasKeepRevert: false,
    hasMetric: true,
    defaultDirection: "lower",
    defaultAcceptanceMode: "log",
    convergenceCheck: "All checklist items checked",
  },
  research: {
    name: "research",
    description: "Hypothesis → implement → measure → log results (no keep/revert)",
    hasKeepRevert: false,
    hasMetric: true,
    defaultDirection: "lower",
    defaultAcceptanceMode: "log",
    convergenceCheck: "Budget exhaustion or user stop",
  },
  dev: {
    name: "dev",
    description: "Pick task → implement → test → commit",
    hasKeepRevert: false,
    hasMetric: false,
    defaultDirection: "lower",
    defaultAcceptanceMode: "log",
    convergenceCheck: "All tasks passing",
  },
};

const MODE_KEYWORDS: Record<LoopMode, string[]> = {
  optimize: [
    "optimize", "improve", "reduce", "increase", "faster", "slower",
    "latency", "throughput", "performance", "tune", "kernel",
    "speed", "efficiency", "minimize", "maximize",
  ],
  punchlist: [
    "punchlist", "checklist", "plan", "todo", "implement all",
    "complete all", "finish all", "check off", "[ ]",
  ],
  research: [
    "ablation", "study", "compare", "sweep", "experiment",
    "measure", "benchmark", "test different", "try each",
    "parameter sweep", "grid search",
  ],
  dev: [
    "implement", "build", "create", "develop", "add feature",
    "fix bug", "refactor", "write", "code",
  ],
};

export function detectMode(prompt: string): LoopMode {
  const lower = prompt.toLowerCase();

  let bestMode: LoopMode = "optimize";
  let bestScore = 0;

  for (const [mode, keywords] of Object.entries(MODE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMode = mode as LoopMode;
    }
  }

  return bestMode;
}

export type PunchlistState = "open" | "done" | "partial";

export interface PunchlistItem {
  index: number;
  text: string;
  checked: boolean;
  state: PunchlistState;
  marker: " " | "x" | "X" | "~";
  line: number;
}

export function parsePunchlist(content: string): PunchlistItem[] {
  const items: PunchlistItem[] = [];
  const lines = content.split("\n");
  let index = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*[-*]\s+)\[([ xX~])\]\s+(.+)$/);
    if (match) {
      const marker = match[2] as " " | "x" | "X" | "~";
      const state: PunchlistState = marker === " "
        ? "open"
        : marker === "~"
          ? "partial"
          : "done";
      items.push({
        index: index++,
        text: match[3].trim(),
        checked: state === "done",
        state,
        marker,
        line: i + 1,
      });
    }
  }

  return items;
}

export function nextUncheckedItem(items: PunchlistItem[]): PunchlistItem | null {
  return items.find((item) => !item.checked) ?? null;
}

export function checkOffItem(
  filePath: string,
  lineNumber: number
): void {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const idx = lineNumber - 1;
  if (idx >= 0 && idx < lines.length) {
    lines[idx] = lines[idx].replace(/\[[ ~]\]/, "[x]");
    writeFileSync(filePath, lines.join("\n"));
  }
}

export function punchlistProgress(items: PunchlistItem[]): {
  total: number;
  open: number;
  done: number;
  partial: number;
  remaining: number;
  pct: number;
} {
  const total = items.length;
  const open = items.filter((i) => i.state === "open").length;
  const done = items.filter((i) => i.state === "done").length;
  const partial = items.filter((i) => i.state === "partial").length;
  return {
    total,
    open,
    done,
    partial,
    remaining: open + partial,
    pct: total > 0 ? Math.round((done / total) * 100) : 100,
  };
}

export function punchlistVerifierMetric(items: PunchlistItem[]): {
  metricName: "open_or_partial_items";
  value: number;
  direction: "lower";
  total: number;
  open: number;
  done: number;
  partial: number;
  output: string;
} {
  const progress = punchlistProgress(items);
  const value = progress.open + progress.partial;
  return {
    metricName: "open_or_partial_items",
    value,
    direction: "lower",
    total: progress.total,
    open: progress.open,
    done: progress.done,
    partial: progress.partial,
    output: [
      `metric: ${value}`,
      `metricName: open_or_partial_items`,
      `direction: lower`,
      `total: ${progress.total}`,
      `open: ${progress.open}`,
      `partial: ${progress.partial}`,
      `done: ${progress.done}`,
    ].join("\n"),
  };
}
