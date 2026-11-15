import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

export function Modal({ open, onClose, label, labelledBy, className = '', children }: {
  open: boolean; onClose: () => void; label?: string; labelledBy?: string;
  className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { const dialog = ref.current; return () => dialog?.close(); }, []);
  const pressedOutside = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  const outside = (x: number, y: number) => {
    const r = ref.current!.getBoundingClientRect();
    return x < r.left || x > r.right || y < r.top || y > r.bottom;
  };
  return (
    <dialog ref={ref} aria-label={label} aria-labelledby={labelledBy} className={`no-print vela-modal ${className}`}
      onClose={() => { if (open && !ref.current?.open) onClose(); }}
      onPointerDown={(e) => { pressedOutside.current = outside(e.clientX, e.clientY); }}
      onPointerUp={(e) => { if (pressedOutside.current && outside(e.clientX, e.clientY)) ref.current?.close(); pressedOutside.current = false; }}>
      {children}
    </dialog>
  );
}
