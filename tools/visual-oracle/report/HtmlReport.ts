import type { JudgeResult } from '../judge/LlmJudge.js';

export interface ScenarioReport {
  id: string;
  name: string;
  description: string;
  originalScreenshots: Buffer[];
  remakeScreenshots: Buffer[];
  judgeResult: JudgeResult | null;
  minimumScore: number;
}

/**
 * Generates a self-contained HTML visual diff report.
 * All images are embedded as base64 data URIs.
 */
export function generateHtmlReport(scenarios: ScenarioReport[]): string {
  const timestamp = new Date().toISOString();
  const scenarioHtml = scenarios.map(renderScenario).join('\n');

  // Compute summary stats
  const judged = scenarios.filter(s => s.judgeResult);
  const avgScore = judged.length > 0
    ? judged.reduce((sum, s) => sum + s.judgeResult!.overallScore, 0) / judged.length
    : 0;
  const passCount = judged.filter(s => s.judgeResult!.overallScore >= s.minimumScore).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Visual Oracle Report — Emperor: Battle for Dune</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 24px; }
  h1 { font-size: 28px; margin-bottom: 8px; color: #f0c040; }
  .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
  .summary { display: flex; gap: 24px; margin-bottom: 32px; padding: 16px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333; }
  .summary-stat { text-align: center; }
  .summary-stat .value { font-size: 36px; font-weight: bold; }
  .summary-stat .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .scenario { margin-bottom: 48px; padding: 24px; background: #141414; border-radius: 12px; border: 1px solid #2a2a2a; }
  .scenario-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .scenario-header h2 { font-size: 20px; color: #d0d0d0; }
  .scenario-desc { color: #888; font-size: 14px; margin-bottom: 20px; }
  .score-badge { font-size: 24px; font-weight: bold; padding: 8px 16px; border-radius: 8px; min-width: 60px; text-align: center; }
  .score-red { background: #3a1515; color: #ff6060; border: 1px solid #5a2020; }
  .score-yellow { background: #3a3015; color: #f0c040; border: 1px solid #5a5020; }
  .score-green { background: #153a15; color: #60ff60; border: 1px solid #205a20; }
  .gallery { display: flex; gap: 16px; margin-bottom: 20px; overflow-x: auto; }
  .gallery-col { flex: 1; min-width: 0; }
  .gallery-col h3 { font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .gallery-col img { width: 100%; border-radius: 4px; border: 1px solid #333; margin-bottom: 8px; display: block; }
  .aspects { display: flex; gap: 24px; margin-bottom: 20px; flex-wrap: wrap; }
  .aspect-chart { flex: 0 0 280px; }
  .aspect-list { flex: 1; }
  .aspect-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .aspect-name { width: 140px; font-size: 13px; color: #aaa; text-transform: capitalize; }
  .aspect-bar-bg { flex: 1; height: 8px; background: #222; border-radius: 4px; overflow: hidden; }
  .aspect-bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .aspect-score { width: 30px; text-align: right; font-size: 13px; font-weight: bold; }
  .feedback { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
  .feedback-section h4 { font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .feedback-section ul { list-style: none; padding: 0; }
  .feedback-section li { font-size: 13px; padding: 4px 0; padding-left: 16px; position: relative; color: #bbb; }
  .feedback-section li::before { content: ''; position: absolute; left: 0; top: 10px; width: 6px; height: 6px; border-radius: 50%; }
  .similarities li::before { background: #60ff60; }
  .differences li::before { background: #ff6060; }
  .suggestions li::before { background: #6090ff; }
  .radar-svg { display: block; margin: 0 auto; }
  .no-judge { color: #666; font-style: italic; padding: 20px; text-align: center; }
  @media (max-width: 768px) {
    .gallery { flex-direction: column; }
    .feedback { grid-template-columns: 1fr; }
    .aspects { flex-direction: column; }
  }
</style>
</head>
<body>
<h1>Visual Oracle Report</h1>
<p class="subtitle">Emperor: Battle for Dune — Original vs Web Remake | ${timestamp}</p>

<div class="summary">
  <div class="summary-stat">
    <div class="value">${scenarios.length}</div>
    <div class="label">Scenarios</div>
  </div>
  <div class="summary-stat">
    <div class="value ${scoreColorClass(avgScore)}">${avgScore.toFixed(1)}</div>
    <div class="label">Avg Score</div>
  </div>
  <div class="summary-stat">
    <div class="value">${passCount}/${judged.length}</div>
    <div class="label">Passing</div>
  </div>
</div>

${scenarioHtml}

<footer style="text-align: center; color: #444; font-size: 12px; margin-top: 40px; padding-top: 20px; border-top: 1px solid #222;">
  Generated by Visual Oracle | ${timestamp}
</footer>
</body>
</html>`;
}

function renderScenario(scenario: ScenarioReport): string {
  const result = scenario.judgeResult;
  const scoreClass = result ? scoreColorClass(result.overallScore) : '';
  const scoreBadge = result
    ? `<div class="score-badge ${scoreColorClass(result.overallScore)}">${result.overallScore}/10</div>`
    : '<div class="score-badge" style="background:#222;color:#666">N/A</div>';

  // Image galleries
  const origImgs = scenario.originalScreenshots.map((buf, i) =>
    `<img src="data:image/png;base64,${buf.toString('base64')}" alt="Original ${i + 1}" loading="lazy">`
  ).join('\n');

  const remakeImgs = scenario.remakeScreenshots.map((buf, i) =>
    `<img src="data:image/png;base64,${buf.toString('base64')}" alt="Remake ${i + 1}" loading="lazy">`
  ).join('\n');

  // Aspect scores
  const aspectHtml = result ? renderAspects(result) : '<div class="no-judge">No LLM judge results available</div>';

  // Feedback
  const feedbackHtml = result ? renderFeedback(result) : '';

  return `
<div class="scenario">
  <div class="scenario-header">
    <h2>${escapeHtml(scenario.name)}</h2>
    ${scoreBadge}
  </div>
  <p class="scenario-desc">${escapeHtml(scenario.description)}</p>

  <div class="gallery">
    <div class="gallery-col">
      <h3>Original Game</h3>
      ${origImgs || '<p style="color:#666">No screenshots captured</p>'}
    </div>
    <div class="gallery-col">
      <h3>Web Remake</h3>
      ${remakeImgs || '<p style="color:#666">No screenshots captured</p>'}
    </div>
  </div>

  ${aspectHtml}
  ${feedbackHtml}
</div>`;
}

function renderAspects(result: JudgeResult): string {
  const entries = Object.entries(result.aspectScores);

  // Bar chart
  const bars = entries.map(([name, score]) => {
    const pct = (score / 10) * 100;
    const color = scoreColor(score);
    return `
    <div class="aspect-row">
      <div class="aspect-name">${escapeHtml(name.replace(/_/g, ' '))}</div>
      <div class="aspect-bar-bg">
        <div class="aspect-bar" style="width:${pct}%; background:${color}"></div>
      </div>
      <div class="aspect-score" style="color:${color}">${score}</div>
    </div>`;
  }).join('');

  // Radar chart SVG
  const radarSvg = renderRadarChart(entries);

  return `
  <div class="aspects">
    <div class="aspect-chart">${radarSvg}</div>
    <div class="aspect-list">${bars}</div>
  </div>`;
}

function renderRadarChart(entries: [string, number][]): string {
  const size = 260;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 100;
  const n = entries.length;

  if (n < 3) return ''; // Need at least 3 points for a radar

  // Grid lines
  const gridLines: string[] = [];
  for (const level of [0.25, 0.5, 0.75, 1.0]) {
    const points = entries.map((_, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = radius * level;
      return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
    }).join(' ');
    gridLines.push(`<polygon points="${points}" fill="none" stroke="#333" stroke-width="1"/>`);
  }

  // Axis lines
  const axes = entries.map((_, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#333" stroke-width="1"/>`;
  }).join('');

  // Data polygon
  const dataPoints = entries.map(([, score], i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = radius * (score / 10);
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
  }).join(' ');

  // Labels
  const labels = entries.map(([name], i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + (radius + 20) * Math.cos(angle);
    const y = cy + (radius + 20) * Math.sin(angle);
    const anchor = Math.abs(Math.cos(angle)) < 0.1 ? 'middle'
      : Math.cos(angle) > 0 ? 'start' : 'end';
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" fill="#888" font-size="11">${escapeHtml(name.replace(/_/g, ' '))}</text>`;
  }).join('');

  return `
  <svg class="radar-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${gridLines.join('\n')}
    ${axes}
    <polygon points="${dataPoints}" fill="rgba(240,192,64,0.2)" stroke="#f0c040" stroke-width="2"/>
    ${labels}
  </svg>`;
}

function renderFeedback(result: JudgeResult): string {
  const simItems = result.similarities.map(s => `<li>${escapeHtml(s)}</li>`).join('');
  const diffItems = result.differences.map(d => `<li>${escapeHtml(d)}</li>`).join('');
  const sugItems = result.suggestions.map(s => `<li>${escapeHtml(s)}</li>`).join('');

  return `
  <div class="feedback">
    <div class="feedback-section similarities">
      <h4>Similarities</h4>
      <ul>${simItems || '<li>None noted</li>'}</ul>
    </div>
    <div class="feedback-section differences">
      <h4>Differences</h4>
      <ul>${diffItems || '<li>None noted</li>'}</ul>
    </div>
    <div class="feedback-section suggestions">
      <h4>Suggestions</h4>
      <ul>${sugItems || '<li>None noted</li>'}</ul>
    </div>
  </div>`;
}

function scoreColor(score: number): string {
  if (score < 4) return '#ff6060';
  if (score < 7) return '#f0c040';
  return '#60ff60';
}

function scoreColorClass(score: number): string {
  if (score < 4) return 'score-red';
  if (score < 7) return 'score-yellow';
  return 'score-green';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
