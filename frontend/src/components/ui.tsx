import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { pad2 } from '../lib/format';

/* ---------- labels and messages ---------- */

function LabelText({ label, required, optional }: { label: string; required?: boolean; optional?: boolean }) {
  return (
    <>
      {label}
      {optional ? (
        <span className="opt"> (optional)</span>
      ) : required ? (
        <span className="req" aria-hidden="true">
          *
        </span>
      ) : null}
    </>
  );
}

function FieldFoot({ id, error, hint, fmt }: { id: string; error?: string; hint?: string; fmt?: string }) {
  if (error)
    return (
      <span className="err" id={`${id}-d`}>
        {error}
      </span>
    );
  if (!hint && !fmt) return <span className="hint" id={`${id}-d`} />;
  return (
    <span className="hint" id={`${id}-d`}>
      {hint}
      {fmt ? (
        <>
          {hint ? ' · ' : ''}Format<span className="mono">{fmt}</span>
        </>
      ) : null}
    </span>
  );
}

/* ---------- inputs ---------- */

interface BaseFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  hint?: string;
  fmt?: string;
  required?: boolean;
  optional?: boolean;
  full?: boolean;
  valid?: boolean;
}

export function TextField(
  p: BaseFieldProps & {
    type?: string;
    inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email';
    placeholder?: string;
    prefix?: string;
    suffix?: string;
    maxLength?: number;
    readOnly?: boolean;
    autoComplete?: string;
    upper?: boolean;
  },
) {
  const cls = `ctl${p.error ? ' bad' : ''}${p.valid && !p.error ? ' good' : ''}`;
  return (
    <div className={`field${p.full ? ' full' : ''}`}>
      <label htmlFor={p.id}>
        <LabelText label={p.label} required={p.required} optional={p.optional} />
      </label>
      <div className={cls}>
        {p.prefix ? <span className="affix">{p.prefix}</span> : null}
        <input
          id={p.id}
          name={p.id}
          type={p.type || 'text'}
          inputMode={p.inputMode}
          value={p.value}
          placeholder={p.placeholder}
          maxLength={p.maxLength}
          readOnly={p.readOnly}
          autoComplete={p.autoComplete}
          aria-invalid={!!p.error}
          aria-required={p.required || undefined}
          aria-describedby={`${p.id}-d`}
          onChange={(e) => p.onChange(p.upper ? e.target.value.toUpperCase() : e.target.value)}
          onBlur={p.onBlur}
        />
        {p.suffix ? <span className="affix">{p.suffix}</span> : null}
      </div>
      <FieldFoot id={p.id} error={p.error} hint={p.hint} fmt={p.fmt} />
    </div>
  );
}

export function TextAreaField(p: BaseFieldProps & { placeholder?: string; maxLength?: number; rows?: number }) {
  const cls = `ctl${p.error ? ' bad' : ''}${p.valid && !p.error ? ' good' : ''}`;
  return (
    <div className={`field${p.full ? ' full' : ''}`}>
      <label htmlFor={p.id}>
        <LabelText label={p.label} required={p.required} optional={p.optional} />
      </label>
      <div className={cls}>
        <textarea
          id={p.id}
          name={p.id}
          rows={p.rows ?? 2}
          value={p.value}
          placeholder={p.placeholder}
          maxLength={p.maxLength}
          aria-invalid={!!p.error}
          aria-required={p.required || undefined}
          aria-describedby={`${p.id}-d`}
          onChange={(e) => p.onChange(e.target.value)}
          onBlur={p.onBlur}
        />
      </div>
      <FieldFoot id={p.id} error={p.error} hint={p.hint} fmt={p.fmt} />
    </div>
  );
}

export function SelectField(p: BaseFieldProps & { options: string[] }) {
  return (
    <div className={`field${p.full ? ' full' : ''}`}>
      <label htmlFor={p.id}>
        <LabelText label={p.label} required={p.required} optional={p.optional} />
      </label>
      <div className="ctl sel">
        <select id={p.id} name={p.id} value={p.value} onChange={(e) => p.onChange(e.target.value)} onBlur={p.onBlur} aria-describedby={`${p.id}-d`}>
          {p.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
      <FieldFoot id={p.id} error={p.error} hint={p.hint} fmt={p.fmt} />
    </div>
  );
}

export function Segmented<T extends string>(p: { id: string; label: string; options: T[]; value: T; onChange: (v: T) => void; full?: boolean }) {
  return (
    <div className={`field${p.full ? ' full' : ''}`}>
      <span className="legend" id={`${p.id}-l`}>
        <LabelText label={p.label} required />
      </span>
      <div className="seg" role="radiogroup" aria-labelledby={`${p.id}-l`}>
        {p.options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={p.value === o} aria-pressed={p.value === o} onClick={() => p.onChange(o)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Chips(p: { id: string; label: string; options: string[]; values: string[]; onChange: (v: string[]) => void; hint?: string; optional?: boolean; full?: boolean }) {
  const toggle = (o: string) => p.onChange(p.values.includes(o) ? p.values.filter((x) => x !== o) : [...p.values, o]);
  return (
    <div className={`field${p.full ? ' full' : ''}`}>
      <span className="legend" id={`${p.id}-l`}>
        <LabelText label={p.label} optional={p.optional} />
      </span>
      <div className="chips" role="group" aria-labelledby={`${p.id}-l`}>
        {p.options.map((o) => (
          <button key={o} type="button" aria-pressed={p.values.includes(o)} onClick={() => toggle(o)}>
            {o}
          </button>
        ))}
      </div>
      {p.hint ? <span className="hint">{p.hint}</span> : null}
    </div>
  );
}

export function Checkbox(p: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode; note?: string; required?: boolean }) {
  return (
    <label className={`decl${p.checked ? ' on' : ''}`} htmlFor={p.id}>
      <input type="checkbox" id={p.id} checked={p.checked} onChange={(e) => p.onChange(e.target.checked)} />
      <span>
        {p.children}
        {p.required ? (
          <span className="req" aria-hidden="true">
            *
          </span>
        ) : null}
        {p.note ? <small>{p.note}</small> : null}
      </span>
    </label>
  );
}

/* ---------- layout pieces ---------- */

export function GroupHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="group-head full">
      <h4>{title}</h4>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}

export function SecTitle({ title, num, desc }: { title: string; num: string; desc?: string }) {
  return (
    <div>
      <h2 className="sec-title">
        {title}
        <sup>({num})</sup>
      </h2>
      {desc ? <p className="sec-desc">{desc}</p> : null}
    </div>
  );
}

export function Guide({ title, tips, ready }: { title: string; tips: string[]; ready?: string[] }) {
  return (
    <div className="guide">
      <h3>{title}</h3>
      <ol>
        {tips.map((t) => (
          <li key={t}>
            <span>{t}</span>
          </li>
        ))}
      </ol>
      {ready && ready.length ? (
        <>
          <h3>Have ready</h3>
          <div className="ready">
            {ready.map((r) => (
              <span key={r}>{r}</span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export type StepState = 'done' | 'current' | 'todo' | 'error';

export function StepList({ items, onGo }: { items: { title: string; state: StepState }[]; onGo?: (i: number) => void }) {
  const label: Record<StepState, string> = { done: 'Done', current: 'Current', todo: '', error: 'Needs fixing' };
  return (
    <ol className="steps">
      {items.map((it, i) => (
        <li key={it.title} data-state={it.state}>
          <button type="button" disabled={!onGo || it.state === 'todo'} onClick={() => onGo?.(i)}>
            <span className="n">{pad2(i + 1)}</span>
            <span className="t">{it.title}</span>
            <span className="s">{label[it.state]}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function ProgressBar({ index, total, label }: { index: number; total: number; label: string }) {
  const pct = Math.round((Math.min(index, total) / total) * 100);
  return (
    <div className="progress">
      <div className="row">
        <span>
          <strong>{label}</strong>
        </span>
        <span>{pct}% complete</span>
      </div>
      <div className="bar" style={{ gridTemplateColumns: `repeat(${total},1fr)` }} aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={i < index ? 'on' : i === index ? 'cur' : ''} />
        ))}
      </div>
    </div>
  );
}

export interface FieldError {
  id: string;
  label: string;
  msg: string;
}

export function ErrorSummary({ errors }: { errors: FieldError[] }) {
  if (!errors.length) return null;
  const go = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: 'center' });
    }
  };
  return (
    <div className="summary" role="alert" tabIndex={-1} id="error-summary">
      <strong>
        Fix {errors.length} field{errors.length > 1 ? 's' : ''} to continue
      </strong>
      <ul>
        {errors.map((e) => (
          <li key={e.id}>
            <a
              href={`#${e.id}`}
              onClick={(ev) => {
                ev.preventDefault();
                go(e.id);
              }}
            >
              {e.label}: {e.msg}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Callout({ tag, children, variant = 'info' }: { tag: string; children: ReactNode; variant?: 'info' | 'warn' | 'ok' }) {
  const cls = variant === 'warn' ? 'warn' : variant === 'ok' ? 'okbox' : 'callout';
  return (
    <div className={cls} role={variant === 'warn' ? 'status' : undefined}>
      <span className="mono">{tag}</span>
      <span>{children}</span>
    </div>
  );
}

export function Button({ loading, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button className="btn" type={rest.type || 'submit'} {...rest} disabled={rest.disabled || loading} aria-busy={loading || undefined}>
      {children}
      {loading ? <span className="spin" aria-hidden="true" /> : <span className="arr">→</span>}
    </button>
  );
}

export function TextButton({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className="link" type="button" {...rest}>
      {children}
    </button>
  );
}

export function Actions({ left, children }: { left?: ReactNode; children: ReactNode }) {
  return (
    <div className="actions">
      {left ?? <span />}
      {children}
    </div>
  );
}

export function DefList({ rows, className = 'ro' }: { rows: [string, ReactNode][]; className?: string }) {
  return (
    <dl className={className}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Loading({ text = 'Loading' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      {text}
    </div>
  );
}

export function NextSteps({ items }: { items: { title: string; text: string }[] }) {
  return (
    <ol className="next" style={{ marginTop: 28 }}>
      {items.map((it, i) => (
        <li key={it.title}>
          <span className="n">{pad2(i + 1)}</span>
          <div>
            <strong>{it.title}</strong>
            <p>{it.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
