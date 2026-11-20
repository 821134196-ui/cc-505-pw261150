import { useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { useApp } from '../lib/store.jsx';

export function Badge({ children, tone = '', className = '', dot = false, title }) {
  return (
    <span className={`badge ${tone} ${className}`.trim()} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function VerdictBadge({ verdict, label, size }) {
  if (!verdict) {
    return <Badge className="draft">{label || '未复核'}</Badge>;
  }
  const map = {
    true_positive: { cls: 'tp', text: '真实异常' },
    false_positive: { cls: 'fp', text: '误报' },
    data_issue: { cls: 'di', text: '数据问题' },
  };
  const m = map[verdict] || { cls: '', text: verdict };
  return <Badge tone={m.cls} dot>{size === 'short' ? m.text.slice(0, 2) : (label || m.text)}</Badge>;
}

export function SeverityBadge({ severity }) {
  const map = {
    critical: { cls: 'critical', text: '严重' },
    warning: { cls: 'warning', text: '警告' },
    watch: { cls: 'watch', text: '观察' },
  };
  const m = map[severity] || { cls: 'watch', text: severity };
  return <Badge tone={m.cls}>{m.text}</Badge>;
}

export function Modal({ title, subtitle, onClose, children, footer, labelledBy = 'modal-title' }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="overlay center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref} tabIndex={-1}>
        <div className="card-head" style={{ padding: '16px 20px' }}>
          <div className="grow">
            <h2 id={labelledBy}>{title}</h2>
            {subtitle && <div className="card-sub" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="btn ghost sm" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ padding: '18px 20px' }} className="stack">{children}</div>
        {footer && (
          <div className="row" style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children, headerExtra }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head">
          <div className="grow">
            <div className="section-label">{subtitle}</div>
            <h2 style={{ marginTop: 3 }}>{title}</h2>
            {headerExtra}
          </div>
          <button className="btn ghost sm" onClick={onClose} aria-label="关闭详情">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div
      style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 200, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(380px, calc(100vw - 40px))' }}
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div key={t.id} className={`notice ${t.kind}`} style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
          <Icon name={t.kind === 'danger' ? 'alert' : t.kind === 'success' ? 'check' : 'info'} size={15} />
          <div className="grow">
            <div className="strong" style={{ fontSize: 13 }}>{t.message}</div>
            {t.detail && <div className="small secondary" style={{ marginTop: 2 }}>{t.detail}</div>}
          </div>
          <button className="btn ghost sm" onClick={() => dismissToast(t.id)} aria-label="关闭提示">
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, hint, action }) {
  return (
    <div className="empty">
      <div className="strong" style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>{title}</div>
      {hint && <div className="small">{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Spinner({ label = '加载中…' }) {
  return (
    <div className="empty" role="status">
      <div className="skeleton" style={{ height: 12, width: 120, margin: '0 auto 10px' }} />
      <div className="skeleton" style={{ height: 12, width: 80, margin: '0 auto' }} />
      <div className="sr-only">{label}</div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div className="notice danger" role="alert">
      <Icon name="alert" size={15} />
      <div className="grow">
        <div className="strong">加载失败</div>
        <div className="small" style={{ marginTop: 2 }}>{error?.message || String(error)}</div>
      </div>
      {onRetry && <button className="btn sm" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Delta({ value, suffix = '', digits = 2, invertGood = false, format }) {
  if (value == null) return <span className="muted">—</span>;
  const flat = Math.abs(value) < 1e-9;
  const good = invertGood ? value > 0 : value < 0;
  const color = flat ? 'var(--text-muted)' : good ? 'var(--good-text)' : 'var(--critical)';
  const text = format ? format(value) : `${value > 0 ? '+' : ''}${value.toFixed(digits)}${suffix}`;
  return <span className="tabular" style={{ color, fontWeight: 560 }}>{text}</span>;
}
