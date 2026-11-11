import { useRef } from 'react';

/** Six single-digit boxes. Supports typing, backspace and pasting the whole code. */
export function OtpInput(p: { value: string; onChange: (v: string) => void; labelledBy: string; autoFocus?: boolean; disabled?: boolean; length?: number }) {
  const len = p.length ?? 6;
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: len }, (_, i) => p.value[i] ?? '');

  const setAt = (i: number, d: string) => {
    const next = digits.slice();
    next[i] = d;
    p.onChange(next.join('').slice(0, len));
  };

  return (
    <div className="otp" role="group" aria-labelledby={p.labelledBy}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={i === 0 ? `${p.labelledBy}-0` : undefined}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          aria-label={`Digit ${i + 1}`}
          value={d}
          disabled={p.disabled}
          autoFocus={p.autoFocus && i === 0}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(-1);
            setAt(i, v);
            if (v && i < len - 1) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !d && i > 0) refs.current[i - 1]?.focus();
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, len);
            if (!t) return;
            e.preventDefault();
            p.onChange(t);
            refs.current[Math.min(t.length, len - 1)]?.focus();
          }}
        />
      ))}
    </div>
  );
}
