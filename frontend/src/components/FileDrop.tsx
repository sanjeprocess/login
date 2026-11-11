import { fileSize } from '../lib/format';

/** File picker with a list of chosen files and remove buttons. */
export function FileDrop(p: {
  id: string;
  label: string;
  hint: string;
  accept: string[];
  multiple?: boolean;
  files: File[];
  onChange: (files: File[]) => void;
  error?: string;
}) {
  return (
    <div className="field full">
      <span className="legend" id={`${p.id}-l`}>
        {p.label}
        <span className="req" aria-hidden="true">
          *
        </span>
      </span>
      <div className={`drop${p.error ? ' bad' : ''}`}>
        <span>{p.hint}</span>
        <label className="ghost" style={{ display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
          Choose file{p.multiple ? 's' : ''}
          <input
            id={p.id}
            type="file"
            multiple={p.multiple}
            accept={p.accept.map((a) => '.' + a).join(',')}
            aria-labelledby={`${p.id}-l`}
            aria-describedby={`${p.id}-d`}
            aria-invalid={!!p.error}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              p.onChange(p.multiple ? [...p.files, ...picked] : picked.slice(0, 1));
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {p.files.length ? (
        <ul className="files">
          {p.files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span>
                {f.name}
                <span className="meta">{fileSize(f.size)}</span>
              </span>
              <button type="button" onClick={() => p.onChange(p.files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {p.error ? (
        <span className="err" id={`${p.id}-d`}>
          {p.error}
        </span>
      ) : (
        <span className="hint" id={`${p.id}-d`} />
      )}
    </div>
  );
}
