import { useCallback, useState } from 'react';
import { validate, type Validator } from './validators';
import type { FieldError } from '../components/ui';

export interface Rule {
  id: string;
  label: string;
  rules: Validator[];
  /** Skip the rule when this returns false (e.g. a field that only applies to registered vehicles). */
  when?: () => boolean;
}

/** Values, touched flags and validation for one form. */
export function useForm(initial: Record<string, string>) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [forced, setForced] = useState(false);

  const set = useCallback((id: string, v: string) => setValues((s) => ({ ...s, [id]: v })), []);
  const touch = useCallback((id: string) => setTouched((t) => ({ ...t, [id]: true })), []);

  /** Error for one field, shown only after it was left or the form was submitted. */
  const errorOf = (rule: Rule | undefined, extra: Record<string, string> = {}): string => {
    if (!rule) return '';
    if (rule.when && !rule.when()) return '';
    if (extra[rule.id]) return extra[rule.id];
    if (!forced && !touched[rule.id]) return '';
    return validate(values[rule.id] ?? '', rule.label, rule.rules);
  };

  /** All current errors, regardless of touched state. */
  const allErrors = (rules: Rule[], extra: Record<string, string> = {}): FieldError[] =>
    rules
      .filter((r) => !r.when || r.when())
      .map((r) => ({ id: r.id, label: r.label, msg: extra[r.id] || validate(values[r.id] ?? '', r.label, r.rules) }))
      .filter((e) => e.msg);

  const isValid = (rule: Rule) => !!touched[rule.id] && !validate(values[rule.id] ?? '', rule.label, rule.rules) && !!String(values[rule.id] ?? '').trim();

  return { values, set, setValues, touched, touch, forced, setForced, errorOf, allErrors, isValid };
}

export function focusSummary() {
  setTimeout(() => {
    const el = document.getElementById('error-summary');
    if (el) {
      el.scrollIntoView?.({ block: 'center' });
      el.focus();
    }
  }, 0);
}
