import { useMemo, useState } from 'react';
import type { SessionRecord } from '@vela-cf/shared';

interface HistorySearchModalProps {
  open: boolean;
  sessions: SessionRecord[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
}

export function HistorySearchModal({
  open,
  sessions,
  activeSessionId,
  onSelectSession,
  onClose,
}: HistorySearchModalProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.profileName.toLowerCase().includes(q) ||
        (s.mode === 'synastry' ? '多人合盘' : '个人星盘').includes(q),
    );
  }, [query, sessions]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-search-title"
      className="no-print fixed inset-0 z-50 flex items-start justify-center bg-black/75 p-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[540px] max-h-[76dvh] rounded-[16px] border border-[#26304d] bg-[#101527] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[#1e2740]">
          <span aria-hidden="true" className="text-[#a3b0c5] text-[15px]">
            🔍
          </span>
          <input
            id="history-search-title"
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索历史咨询标题、档案名或模式…"
            className="flex-1 bg-transparent border-0 text-[14.5px] text-[#f8fafc] placeholder-[#a3b0c5] focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭搜索"
            className="min-h-[32px] min-w-[32px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
          {filtered.length === 0 ? (
            <p className="m-0 py-10 text-center text-[13px] text-[#a3b0c5]">
              {sessions.length === 0 ? '暂无历史咨询记录' : '没有匹配的历史咨询'}
            </p>
          ) : (
            filtered.map((s) => {
              const isActive = s.id === activeSessionId;
              const dateLabel = s.updatedAt.slice(0, 10);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onSelectSession(s.id);
                    onClose();
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-[10px] border flex items-center justify-between gap-3 cursor-pointer ${
                    isActive
                      ? 'border-[#e0b64a]/60 bg-[#1d1a0f] text-[#f8fafc]'
                      : 'border-transparent bg-transparent hover:bg-[#161d33] text-[#c3cde0]'
                  }`}
                >
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <span className="text-[13.5px] font-medium text-[#f8fafc] truncate">
                      {s.title}
                    </span>
                    <span className="text-[11.5px] text-[#a3b0c5] truncate">
                      {s.mode === 'synastry' ? '多人合盘' : '个人星盘'} · {s.profileName}
                    </span>
                  </div>
                  <span className="font-mono-num text-[11px] text-[#a3b0c5] shrink-0">
                    {dateLabel}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
