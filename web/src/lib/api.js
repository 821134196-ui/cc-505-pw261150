const ANALYST_KEY = 'signal-loop.actor';

export const ANALYSTS = ['陈晓', '李明', '王芳', '周涛'];

export function getActor() {
  return localStorage.getItem(ANALYST_KEY) || ANALYSTS[0];
}

export function setActor(name) {
  localStorage.setItem(ANALYST_KEY, name);
}

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `请求失败 (${status})`);
    this.status = status;
    this.code = payload?.error?.code;
    this.details = payload?.error?.details;
  }
}

async function request(method, path, { body, actor } = {}) {
  const headers = { 'x-analyst': encodeURIComponent(actor || getActor()) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const api = {
  metrics: () => request('GET', '/metrics'),
  series: () => request('GET', '/series'),
  anomalies: (query = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
    const qs = params.toString();
    return request('GET', `/anomalies${qs ? `?${qs}` : ''}`);
  },
  anomaly: (id) => request('GET', `/anomalies/${encodeURIComponent(id)}`),
  submitFeedback: (id, body) => request('POST', `/anomalies/${encodeURIComponent(id)}/feedback`, { body }),
  revokeFeedback: (id, body) => request('POST', `/feedback/${encodeURIComponent(id)}/revoke`, { body }),
  versions: () => request('GET', '/versions'),
  version: (id) => request('GET', `/versions/${encodeURIComponent(id)}`),
  createVersion: (body) => request('POST', '/versions', { body }),
  activateVersion: (id, body) => request('POST', `/versions/${encodeURIComponent(id)}/activate`, { body }),
  scan: () => request('POST', '/scan', { body: {} }),
  audit: () => request('GET', '/audit?limit=120'),
};

/* ---------- 展示辅助 ---------- */

export const VERDICT_META = {
  true_positive: { label: '真实异常', short: '真实', cls: 'tp' },
  false_positive: { label: '误报', short: '误报', cls: 'fp' },
  data_issue: { label: '数据问题', short: '数据', cls: 'di' },
};

export const ACTION_LABELS = {
  no_action: '无需处理',
  mute: '静音该模式',
  threshold_review: '复核阈值',
  baseline_fix: '修正基线数据',
  data_pipeline_fix: '修复采集链路',
};

export const SEVERITY_META = {
  critical: { label: '严重', cls: 'critical' },
  warning: { label: '警告', cls: 'warning' },
  watch: { label: '观察', cls: 'watch' },
};

export function severityMeta(s) {
  return SEVERITY_META[s] || { label: s, cls: 'watch' };
}

export function verdictMeta(v) {
  return VERDICT_META[v] || { label: '未复核', short: '未复核', cls: '' };
}

export function fmtTime(iso, { seconds = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return seconds ? `${base}:${pad(d.getSeconds())}` : base;
}

export function fmtHour(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
}

export function fmtPct(v, digits = 1) {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}

export function fmtSigned(v, digits = 2) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

export function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (Math.abs(min) < 1) return '刚刚';
  if (Math.abs(min) < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (Math.abs(h) < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (Math.abs(d) < 30) return `${d} 天前`;
  return fmtTime(iso);
}

export function newRequestId() {
  return (globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
