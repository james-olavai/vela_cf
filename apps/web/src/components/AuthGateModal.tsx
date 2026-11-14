import { useState, type FormEvent } from 'react';
import { navigate } from '../lib/router';

export type EmailAuthMode = 'login' | 'register' | 'magic';

interface AuthGateModalProps {
  open: boolean;
  busy: boolean;
  error: string | null;
  notice?: string | null;
  pendingQuestion?: string;
  onConfirmLogin: () => void;
  onEmailAuth: (mode: EmailAuthMode, email: string, password: string) => void;
  onResetPassword: (email: string) => void;
  onClose: () => void;
}

export function AuthGateModal({
  open,
  busy,
  error,
  notice,
  pendingQuestion,
  onConfirmLogin,
  onEmailAuth,
  onResetPassword,
  onClose,
}: AuthGateModalProps) {
  const [agreed, setAgreed] = useState(false);
  const [emailMode, setEmailMode] = useState<EmailAuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (!open) return null;

  const handleEmailSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agreed || busy || !email.trim()) return;
    onEmailAuth(emailMode, email.trim(), password);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-gate-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-[440px] rounded-[16px] border border-[#26304d] bg-[#101527] p-6 sm:p-7 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="m-0 font-mono-num text-[12px] tracking-[0.14em] text-[#e0b64a]">
              保存档案并开始解读
            </p>
            <h2 id="auth-gate-title" className="m-0 mt-1 font-serif-sc text-[22px] font-bold text-[#f8fafc]">
              登录或注册账号
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

        <p className="m-0 text-[13.5px] leading-[1.65] text-[#c3cde0]">
          登录后将自动保存你的出生档案与历史咨询，并开启免费本命盘 AI 解读（每月 3 次）。
        </p>

        {pendingQuestion && (
          <div className="px-3.5 py-2.5 rounded-[10px] border border-[#26304d] bg-[#161d33] text-[13px] text-[#e8edf6]">
            <span className="text-[#a3b0c5]">即将为你解读：</span>
            <span className="line-clamp-2">{pendingQuestion}</span>
          </div>
        )}

        <label className="flex items-start gap-3 text-[12.5px] leading-[1.55] text-[#c3cde0] cursor-pointer select-none">
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
          <p role="alert" className="m-0 text-[12.5px] text-[#ff9d8a]">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="m-0 text-[12.5px] text-[#f7d57f]">
            {notice}
          </p>
        )}

        <button
          type="button"
          disabled={!agreed || busy}
          onClick={onConfirmLogin}
          className="min-h-[44px] w-full rounded-[10px] bg-[#e0b64a] text-[#1a1405] text-[14.5px] font-bold border-0 cursor-pointer hover:bg-[#f7d57f] disabled:opacity-45 disabled:cursor-not-allowed"
        >
          {busy ? '正在处理…' : '使用 Google 账号继续并开始解读'}
        </button>

        <div className="flex items-center gap-3 text-[11.5px] text-[#7f8da9]">
          <div className="h-px flex-1 bg-[#1e2740]" />
          <span>或使用邮箱认证</span>
          <div className="h-px flex-1 bg-[#1e2740]" />
        </div>

        <form onSubmit={handleEmailSubmit} className="flex flex-col gap-2.5">
          <div className="flex gap-1 rounded-[8px] border border-[#26304d] bg-[#0b0e1a] p-1">
            {(
              [
                { id: 'login', label: '邮箱登录' },
                { id: 'register', label: '注册账号' },
                { id: 'magic', label: '免密邮件链接' },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setEmailMode(m.id)}
                className={`flex-1 min-h-[28px] rounded-[6px] border-0 text-[12px] font-medium cursor-pointer ${
                  emailMode === m.id
                    ? 'bg-[#1d2540] text-[#f7d57f]'
                    : 'bg-transparent text-[#9aa8c7] hover:text-[#f8fafc]'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <input
            required
            type="email"
            placeholder="邮箱地址（如 name@example.com）"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-[40px] px-3 rounded-[8px] border border-[#3a4668] bg-[#070812] text-[#f8fafc] text-[13.5px]"
          />

          {emailMode !== 'magic' && (
            <input
              required
              type="password"
              minLength={6}
              placeholder={emailMode === 'register' ? '设置密码（至少 6 位）' : '输入密码'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="min-h-[40px] px-3 rounded-[8px] border border-[#3a4668] bg-[#070812] text-[#f8fafc] text-[13.5px]"
            />
          )}

          <div className="flex items-center justify-between gap-2">
            {emailMode === 'login' && (
              <button
                type="button"
                disabled={busy || !email.trim()}
                onClick={() => onResetPassword(email.trim())}
                className="bg-transparent border-0 p-0 text-[12px] text-[#a3b0c5] hover:text-[#f7d57f] underline cursor-pointer disabled:opacity-45"
              >
                忘记密码？发送重置邮件
              </button>
            )}
            <button
              type="submit"
              disabled={!agreed || busy || !email.trim() || (emailMode !== 'magic' && password.length < 6)}
              className="ml-auto min-h-[40px] px-4 rounded-[8px] border border-[#e0b64a]/70 bg-[#1d1a0f] text-[#f7d57f] text-[13.5px] font-semibold cursor-pointer hover:bg-[#e0b64a] hover:text-[#1a1405] disabled:opacity-45 disabled:cursor-not-allowed"
            >
              {emailMode === 'login'
                ? '邮箱登录并继续'
                : emailMode === 'register'
                  ? '注册邮箱并继续'
                  : '发送免密登录链接'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
