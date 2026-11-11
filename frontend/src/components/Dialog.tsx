import { useEffect, useRef, type ReactNode } from 'react';

/** Modal confirmation. Escape or Cancel closes it; focus moves into it on open. */
export function Dialog(p: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; actions: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={ref}>
        {p.eyebrow ? <span className="eyebrow">{p.eyebrow}</span> : null}
        <h2 id="dlg-title">{p.title}</h2>
        {p.children}
        <div className="acts">{p.actions}</div>
      </div>
    </div>
  );
}
