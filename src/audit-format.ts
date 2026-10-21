/**
 * Human-readable audit output.
 *
 * Deliberately plain: aligned columns, no score, no badges. The reader is
 * usually deciding what to do next, not admiring a dashboard.
 */
import { formatBytes } from "./diagnostics.js";
import type { AuditReport, Metric } from "./audit.js";

export function formatAudit(report: AuditReport, colors: boolean): string {
  const lines: string[] = [];

  lines.push(paint("Asset health", "bold", colors));
  lines.push(row("declared", String(report.assets.declared), "referenced", String(report.assets.referenced)));
  lines.push(
    row(
      "total size",
      formatBytes(report.assets.totalBytes),
      "largest",
      report.assets.largest ? `${report.assets.largest.path} (${formatBytes(report.assets.largest.bytes)})` : "none",
    ),
  );
  lines.push(
    row(
      "duplicates",
      String(report.assets.duplicates.length),
      "code refs",
      report.assets.undeclaredCodeRefs.length === 0
        ? "every code reference is declared"
        : `${report.assets.undeclaredCodeRefs.length} undeclared`,
    ),
  );

  lines.push("");
  lines.push(paint("Structure", "bold", colors));
  lines.push(row("modules", String(report.structure.modules), "source files", String(report.structure.sourceFiles)));
  lines.push(
    row(
      "code lines",
      String(report.structure.lines),
      "fan-out avg",
      `${report.structure.averageFanOut}${report.structure.maxFanOut ? ` (max ${report.structure.maxFanOut.path}: ${report.structure.maxFanOut.count})` : ""}`,
    ),
  );
  lines.push(
    row(
      "cycles",
      String(report.structure.cycles.length),
      "dup blocks",
      String(report.structure.duplicateBlocks.length),
    ),
  );
  lines.push(row("orphans", String(report.structure.orphanModules.length), "dead exports", String(report.structure.deadExports.length)));

  if (report.metrics.length > 0) {
    lines.push("");
    lines.push(paint("Metrics", "bold", colors));
    for (const metric of report.metrics) {
      lines.push(`  ${gradeLabel(metric, colors)}  ${pad(metric.label, 38)} ${metricLine(metric)}`);
    }
  }

  if (report.findings.length > 0) {
    lines.push("");
    lines.push(paint("Findings", "bold", colors));
    for (const finding of report.findings) {
      lines.push(`  ${finding.code} ${finding.level.padEnd(4)} ${finding.message}`);
      lines.push(`        fix: ${finding.fix}`);
      if (finding.detail && finding.detail.length > 0) {
        lines.push(`        ${finding.detail.join(", ")}`);
      }
    }
  } else {
    lines.push("");
    lines.push(colors ? "\u001b[32mNo audit findings.\u001b[0m" : "No audit findings.");
  }

  if (report.trend.length > 0) {
    lines.push("");
    lines.push(paint(`Trend (last ${Math.min(report.trend.length, 5)} rounds)`, "bold", colors));
    for (const point of report.trend.slice(0, 5)) {
      lines.push(
        `  ${point.at.slice(0, 19)}  ${pad(point.task.slice(0, 34), 34)} ${point.errors} error / ${point.warnings} warning`,
      );
    }
  }

  return lines.join("\n");
}

function metricLine(metric: Metric): string {
  const value = formatMetricValue(metric.value, metric.unit);
  const threshold =
    metric.good === null || metric.ok === null
      ? "no universal threshold"
      : metric.good === metric.ok
        ? `must be ${formatMetricValue(metric.ok, metric.unit)}`
        : `good <= ${formatMetricValue(metric.good, metric.unit)}, ok <= ${formatMetricValue(metric.ok, metric.unit)}`;
  return `${pad(value, 20)} ${threshold}`;
}

function formatMetricValue(value: number, unit: string): string {
  if (unit === "bytes") return formatBytes(value);
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  return `${value} ${unit}`;
}

function gradeLabel(metric: Metric, colors: boolean): string {
  switch (metric.grade) {
    case "good":
      return paint("good", "green", colors).padEnd(colors ? 13 : 5);
    case "ok":
      return paint("ok  ", "yellow", colors).padEnd(colors ? 14 : 5);
    case "bad":
      return paint("bad ", "red", colors).padEnd(colors ? 13 : 5);
    default:
      return paint("info", "dim", colors).padEnd(colors ? 13 : 5);
  }
}

function row(leftLabel: string, leftValue: string, rightLabel: string, rightValue: string): string {
  return `  ${pad(leftLabel, 14)} ${pad(leftValue, 24)} ${pad(rightLabel, 14)} ${rightValue}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function paint(text: string, tone: "bold" | "green" | "yellow" | "red" | "dim", colors: boolean): string {
  if (!colors) return text;
  const codes: Record<typeof tone, string> = {
    bold: "\u001b[1m",
    green: "\u001b[32m",
    yellow: "\u001b[33m",
    red: "\u001b[31m",
    dim: "\u001b[2m",
  };
  return `${codes[tone]}${text}\u001b[0m`;
}
