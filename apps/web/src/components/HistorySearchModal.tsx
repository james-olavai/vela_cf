import { Modal } from './Modal';
import { useMemo, useState } from 'react';
import type { SessionRecord } from '@vela-cf/shared';
import { IconSearch } from './Icons';

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


  return (
    <Modal open={open} onClose={onClose} labelledBy="history-search-title" className="w-[calc(100%_-_2rem)] max-w-[540px]">
      <div
        className="w-full max-w-[540px] max-h-[76dvh] rounded-[16px] border border-border bg-panel flex flex-col overflow-hidden"
      >
        <h2 id="history-search-title" className="sr-only">搜索历史咨询</h2>
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-divider">
          <span className="text-muted flex items-center">
            <IconSearch size={17} />
          </span>
          <input
            aria-label="搜索历史咨询"
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索历史咨询标题、档案名或模式…"
            className="flex-1 bg-transparent border-0 text-[14.5px] text-primary placeholder-muted focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭搜索"
            className="min-h-[32px] min-w-[32px] rounded-[8px] border border-border bg-transparent text-secondary hover:text-primary cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
          {filtered.length === 0 ? (
            <p className="m-0 py-10 text-center text-[13px] text-muted">
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
                      ? 'border-accent/60 bg-selected text-primary'
                      : 'border-transparent bg-transparent hover:bg-panel-2 text-secondary'
                  }`}
                >
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <span className="text-[13.5px] font-medium text-primary truncate">
                      {s.title}
                    </span>
                    <span className="text-[13px] text-muted truncate">
                      {s.mode === 'synastry' ? '多人合盘' : '个人星盘'} · {s.profileName}
                    </span>
                  </div>
                  <span className="font-mono-num text-[13px] text-muted shrink-0">
                    {dateLabel}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
