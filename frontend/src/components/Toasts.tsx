import { X } from 'lucide-react';
import { useStore } from '../store';

export default function Toasts() {
  const { toasts, dismiss } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={'toast ' + t.kind}>
          <span>{t.text}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
