import { useMemo, useRef, useState } from 'react';
import { fmtHour } from '../lib/api.js';

/**
 * 单序列时间线 + 告警点。遵循 dataviz 规范：
 * - 2px 线、≥8px 圆点、弱化网格
 * - 单序列不显示图例，标题即身份
 * - 十字准线 hover tooltip
 * - 表格视图作为无障碍替代
 */
export function SeriesChart({ context, anomaly, height = 180 }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const [showTable, setShowTable] = useState(false);

  const pts = context || [];
  const view = useMemo(() => {
    if (pts.length === 0) return null;
    const W = 640;
    const H = height;
    const padL = 44;
    const padR = 14;
    const padT = 14;
    const padB = 26;
    const values = pts.map((p) => p.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const span = max - min || 1;
    min -= span * 0.12;
    max += span * 0.12;
    const x = (ts) => padL + ((Date.parse(ts) - t0) / (t1 - t0 || 1)) * (W - padL - padR);
    const t0 = Date.parse(pts[0].ts);
    const t1 = Date.parse(pts[pts.length - 1].ts);
    const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const ticks = niceTicks(min, max, 4);
    return { W, H, padL, padR, padT, padB, x, y, line, ticks, min, max, t0, t1 };
  }, [pts, height]);

  if (!view) return <div className="empty">该异常周围暂无观测数据</div>;

  const { W, H, padL, padR, padT, padB, x, y, line, ticks } = view;
  const anomalyTs = anomaly?.ts;

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = pts[0];
    let bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(x(p.ts) - px);
      if (d < bestD) { bestD = d; best = p; }
    }
    setHover(best);
  };

  return (
    <div>
      <div className="row spread" style={{ marginBottom: 6 }}>
        <div className="small secondary">
          告警前后各 6 小时的观测值
        </div>
        <button
          className="btn ghost sm"
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
        >
          {showTable ? '隐藏数据表' : '查看数据表'}
        </button>
      </div>

      {!showTable && (
        <div style={{ position: 'relative' }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
            role="img"
            aria-label={`观测值曲线，含 ${pts.length} 个数据点；告警发生于 ${anomaly?.ts || ''}`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
                <text x={padL - 8} y={y(t)} textAnchor="end" dominantBaseline="middle"
                  fill="var(--text-muted)" fontSize="10" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatTick(t)}
                </text>
              </g>
            ))}
            <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke="var(--border-strong)" strokeWidth="1" />
            {[pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]].map((p, i) => (
              <text key={i} x={x(p.ts)} y={H - 8}
                textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
                fill="var(--text-muted)" fontSize="10">
                {fmtHour(p.ts)}
              </text>
            ))}

            <path d={line} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

            {anomalyTs && pts.some((p) => p.ts === anomalyTs) && (
              <line
                x1={x(anomalyTs)} x2={x(anomalyTs)} y1={padT} y2={H - padB}
                stroke="var(--critical)" strokeWidth="1.5" strokeDasharray="3 3"
              />
            )}
            {anomalyTs && pts.some((p) => p.ts === anomalyTs) && (
              <>
                <circle cx={x(anomalyTs)} cy={y(anomaly.value)} r="6"
                  fill="var(--critical)" stroke="var(--surface-1)" strokeWidth="2" />
                <text x={x(anomalyTs)} y={y(anomaly.value) - 12} textAnchor="middle"
                  fill="var(--text-primary)" fontSize="10.5" fontWeight="600">
                  告警 {formatTick(anomaly.value)}
                </text>
              </>
            )}

            {hover && (
              <g pointerEvents="none">
                <line x1={x(hover.ts)} x2={x(hover.ts)} y1={padT} y2={H - padB} stroke="var(--text-muted)" strokeWidth="1" />
                <circle cx={x(hover.ts)} cy={y(hover.value)} r="4.5" fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth="2" />
              </g>
            )}
          </svg>

          {hover && (
            <div
              style={{
                position: 'absolute', top: 0,
                left: `${Math.min(78, Math.max(2, (x(hover.ts) / W) * 100))}%`,
                transform: 'translateX(-50%)', pointerEvents: 'none',
                background: 'var(--surface-1)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 9px', boxShadow: 'var(--shadow)',
                fontSize: 11.5, whiteSpace: 'nowrap', zIndex: 3,
              }}
            >
              <div className="muted">{fmtHour(hover.ts)}</div>
              <div className="tabular strong">{formatTick(hover.value)}</div>
              {hover.z != null && <div className="muted tabular">z = {hover.z.toFixed(2)}</div>}
            </div>
          )}
        </div>
      )}
      {showTable && (
        <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          <table className="data">
            <thead>
              <tr><th>时间</th><th style={{ textAlign: 'right' }}>观测值</th><th style={{ textAlign: 'right' }}>偏离 z</th></tr>
            </thead>
            <tbody>
              {pts.map((p) => (
                <tr key={p.id} style={p.ts === anomalyTs ? { background: 'var(--danger-soft)' } : undefined}>
                  <td className="tabular">{fmtHour(p.ts)}</td>
                  <td className="num tabular">{formatTick(p.value)}</td>
                  <td className="num tabular">{p.z == null ? '—' : p.z.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatTick(v) {
  if (Math.abs(v) >= 1000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function niceTicks(min, max, count) {
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/**
 * 基线与候选版本的回测对比条。两个序列用固定分类色，
 * 直接标注数值；不使用双轴。
 */
export function BacktestBars({ base, candidate }) {
  const metrics = [
    { key: 'precision', label: '精确率', fmt: (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`) },
    { key: 'recall', label: '召回率', fmt: (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`) },
    { key: 'f1', label: 'F1', fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
    { key: 'alerts', label: '告警数', fmt: (v) => String(v) },
    { key: 'fp', label: '误报', fmt: (v) => String(v) },
    { key: 'dataIssue', label: '数据问题', fmt: (v) => String(v) },
  ];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 16, fontSize: 11.5, color: 'var(--text-secondary)' }}>
        <span className="row" style={{ gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--series-1)' }} />基线 {base?.versionLabel || ''}
        </span>
        <span className="row" style={{ gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--series-2)' }} />候选版本
        </span>
      </div>
      <div className="stack" style={{ gap: 11 }}>
        {metrics.map((m) => (
          <BarRow key={m.key} metric={m} base={base?.[m.key]} candidate={candidate?.[m.key]} />
        ))}
      </div>
    </div>
  );
}

function BarRow({ metric, base, candidate }) {
  const max = Math.max(base ?? 0, candidate ?? 0, 1);
  return (
    <div>
      <div className="row spread" style={{ marginBottom: 3 }}>
        <span className="small secondary">{metric.label}</span>
        <span className="tiny muted tabular">
          {metric.fmt(base)} → <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{metric.fmt(candidate)}</span>
        </span>
      </div>
      <div className="stack" style={{ gap: 3 }}>
        <div style={{ height: 7, background: 'var(--surface-3)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${((base ?? 0) / max) * 100}%`, height: '100%', background: 'var(--series-1)', borderRadius: 4 }} />
        </div>
        <div style={{ height: 7, background: 'var(--surface-3)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${((candidate ?? 0) / max) * 100}%`, height: '100%', background: 'var(--series-2)', borderRadius: 4 }} />
        </div>
      </div>
    </div>
  );
}

/** 反馈构成（一次性堆叠条，带 2px 间隙与图例/直接标签）。 */
export function VerdictBar({ counts }) {
  const parts = [
    { key: 'true_positive', label: '真实异常', color: 'var(--good)', value: counts.true_positive || 0 },
    { key: 'false_positive', label: '误报', color: 'var(--warning)', value: counts.false_positive || 0 },
    { key: 'data_issue', label: '数据问题', color: 'var(--series-1)', value: counts.data_issue || 0 },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div>
      <div style={{ display: 'flex', gap: 2, height: 14, borderRadius: 4, overflow: 'hidden', marginBottom: 9 }}>
        {total === 0
          ? <div style={{ flex: 1, background: 'var(--surface-3)', borderRadius: 4 }} />
          : parts.filter((p) => p.value > 0).map((p) => (
            <div
              key={p.key}
              title={`${p.label}: ${p.value}`}
              style={{ width: `${(p.value / total) * 100}%`, background: p.color, borderRadius: 3 }}
            />
          ))}
      </div>
      <div className="row wrap" style={{ gap: 12, fontSize: 11.5, color: 'var(--text-secondary)' }}>
        {parts.map((p) => (
          <span key={p.key} className="row" style={{ gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
            {p.label} <span className="tabular strong" style={{ color: 'var(--text-primary)' }}>{p.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
