import { useState } from 'react';
import { navigate } from '../lib/router';

interface AuthGateModalProps {
  open: boolean;
  busy: boolean;
  error: string | null;
  pendingQuestion?: string;
  onConfirmLogin: () => void;
  onClose: () => void;
}

export function AuthGateModal({
  open,
  busy,
  error,
  pendingQuestion,
  onConfirmLogin,
  onClose,
}: AuthGateModalProps) {
  const [agreed, setAgreed] = useState(false);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-gate-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-[440px] rounded-[16px] border border-[#26304d] bg-[#101527] p-6 sm:p-7 flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="m-0 font-mono-num text-[12px] tracking-[0.14em] text-[#e0b64a]">
              保存档案并开始解读
            </p>
            <h2 id="auth-gate-title" className="m-0 mt-1 font-serif-sc text-[22px] font-bold text-[#f8fafc]">
              使用 Google 账号继续
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="min-h-[36px] min-w-[36px] rounded-[8px] border border-[#26304d] bg-transparent text-[#c3cde0] hover:text-[#f8fafc] cursor-pointer"
          >
            ✕
          </button>
        </div>

        <p className="m-0 text-[14px] leading-[1.7] text-[#c3cde0]">
          登录后将自动保存你的出生档案与历史咨询，并开启免费本命盘 AI 解读（每月 3 次）。
        </p>

        {pendingQuestion && (
          <div className="px-3.5 py-2.5 rounded-[10px] border border-[#26304d] bg-[#161d33] text-[13px] text-[#e8edf6]">
            <span className="text-[#a3b0c5]">即将为你解读：</span>
            <span className="line-clamp-2">{pendingQuestion}</span>
          </div>
        )}

        <label className="flex items-start gap-3 text-[13px] leading-[1.6] text-[#c3cde0] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 h-4 w-4 accent-[#e0b64a] cursor-pointer shrink-0"
          />
          <span>
            我已年满 18 岁，并同意{' '}
            <a
              href="/terms"
              onClick={(e) => {
                e.preventDefault();
                onClose();
                navigate('/terms');
              }}
              className="underline"
            >
              服务条款
            </a>{' '}
            与{' '}
            <a
              href="/privacy"
              onClick={(e) => {
                e.preventDefault();
                onClose();
                navigate('/privacy');
              }}
              className="underline"
            >
              隐私政策
            </a>
            ；如录入亲友出生信息，我确认已获对方同意。
          </span>
        </label>

        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff9d8a]">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={!agreed || busy}
          onClick={onConfirmLogin}
          className="min-h-[48px] w-full rounded-[10px] bg-[#e0b64a] text-[#1a1405] text-[15px] font-bold border-0 cursor-pointer hover:bg-[#f7d57f] disabled:opacity-45 disabled:cursor-not-allowed"
        >
          {busy ? '正在登录并保存档案…' : '使用 Google 账号继续并开始解读'}
        </button>
      </div>
    </div>
  );
}
