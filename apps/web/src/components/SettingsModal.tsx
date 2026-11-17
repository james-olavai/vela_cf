import { Modal } from './Modal';
import { ApiTokensPanel } from './ApiTokensPanel';
import { useEffect, useState, type FormEvent } from 'react';
import { auth, updateAnalyticsConsent } from '../lib/firebase';
import { navigate } from '../lib/router';
import {
  deleteUserAccount,
  exportUserDataJson,
  formatAppError,
} from '../lib/store';

export type EmailAuthMode = 'login' | 'register' | 'magic';

interface SettingsModalProps {
  open: boolean;
  uid: string | null;
  email: string;
  authBusy: boolean;
  authError: string | null;
  authNotice: string | null;
  pendingQuestion?: string;
  consentRequired?: boolean;
  onConfirmConsent: () => void;
  onConfirmGoogleLogin: () => void;
  onEmailAuth: (mode: EmailAuthMode, email: string, password: string) => void;
  onResetPassword: (email: string) => void;
  onClose: () => void;
  onSignOut: () => void;
}

export function SettingsModal({
  open,
  uid,
  email,
  authBusy,
  authError,
  authNotice,
  pendingQuestion,
  consentRequired = false,
  onConfirmConsent,
  onConfirmGoogleLogin,
  onEmailAuth,
  onResetPassword,
  onClose,
  onSignOut,
}: SettingsModalProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [emailMode, setEmailMode] = useState<EmailAuthMode>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [password, setPassword] = useState('');
  const [deleteText, setDeleteText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('vela_consent_choice') === 'granted',
  );

  useEffect(() => {
    if (open) setNotice(null);
  }, [open]);


  const handleEmailSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (authBusy || !authEmail.trim()) return;
    onEmailAuth(emailMode, authEmail.trim(), password);
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="settings-title" className="w-[calc(100%_-_2rem)] max-w-[580px]">
      <div className="w-full max-w-[580px] max-h-[88dvh] rounded-[16px] border border-border bg-panel flex flex-col overflow-hidden">
        <div className="h-[56px] shrink-0 flex items-center justify-between px-6 border-b border-divider">
          <h2 id="settings-title" className="m-0 font-serif-sc text-[19px] font-bold text-primary">
            {uid ? '账号与合规设置' : '登录或注册账号'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="min-h-[34px] min-w-[34px] rounded-[8px] border border-border bg-transparent text-secondary hover:text-primary cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
          {notice && (
            <div role="status" className="px-4 py-2.5 rounded-[10px] border border-accent/40 bg-selected text-[13px] text-accent-bright">
              {notice}
            </div>
          )}

          {authError && <p role="alert" className="m-0 text-[13px] text-danger">{authError}</p>}
          {authNotice && <p role="status" className="m-0 text-[13px] text-accent-bright">{authNotice}</p>}

          {!uid ? (
            <div className="p-4 rounded-[12px] border border-border bg-[#0b1020] flex flex-col gap-3.5">
              <div>
                <p className="m-0 text-[14px] font-bold text-primary">登录或创建你的 Vela 账号</p>
                <p className="m-0 mt-1 text-[13px] leading-[1.6] text-muted">
                  登录后自动保存出生档案与历史咨询，并开启免费本命盘 AI 解读（每月 3 次）。
                </p>
              </div>

              {pendingQuestion && (
                <div className="px-3.5 py-2 rounded-[10px] border border-border bg-panel-2 text-[13px] text-body">
                  <span className="text-muted">即将为你解读：</span>
                  <span className="line-clamp-2">{pendingQuestion}</span>
                </div>
              )}


              <button
                type="button"
                disabled={authBusy}
                onClick={onConfirmGoogleLogin}
                className="min-h-[42px] w-full rounded-[10px] bg-accent text-on-accent text-[14px] font-bold border-0 cursor-pointer hover:bg-accent-bright disabled:opacity-45 disabled:cursor-not-allowed"
              >
                {authBusy ? '正在处理…' : pendingQuestion ? '使用 Google 账号登录并开始解读' : '使用 Google 账号登录'}
              </button>

              <div className="flex items-center gap-3 text-[13px] text-muted">
                <div className="h-px flex-1 bg-divider" />
                <span>或使用邮箱认证</span>
                <div className="h-px flex-1 bg-divider" />
              </div>

              <form onSubmit={handleEmailSubmit} className="flex flex-col gap-2.5">
                <div className="flex gap-1 rounded-[8px] border border-border bg-base p-1">
                  {([
                    { id: 'login', label: '邮箱登录' },
                    { id: 'register', label: '注册账号' },
                    { id: 'magic', label: '免密邮件链接' },
                  ] as const).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={emailMode === m.id} onClick={() => setEmailMode(m.id)}
                      className={`flex-1 min-h-[28px] rounded-[6px] border-0 text-[13px] font-medium cursor-pointer ${
                        emailMode === m.id ? 'bg-bubble text-accent-bright' : 'bg-transparent text-muted hover:text-primary'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                <label htmlFor="auth-email">邮箱地址</label>
                <input id="auth-email" name="email" autoComplete="username"
                  required
                  type="email"
                  placeholder="邮箱地址（如 name@example.com）"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="min-h-[40px] px-3 rounded-[8px] border border-border-strong bg-base text-primary text-[13.5px]"
                />

                {emailMode !== 'magic' && (
                  <label htmlFor="auth-password">密码（至少 6 位）</label>
                )}
                {emailMode !== 'magic' && (
                  <input id="auth-password" name="password" autoComplete={emailMode === 'register' ? 'new-password' : 'current-password'}
                    required
                    type="password"
                    minLength={6}
                    placeholder={emailMode === 'register' ? '设置密码（至少 6 位）' : '输入密码'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-h-[40px] px-3 rounded-[8px] border border-border-strong bg-base text-primary text-[13.5px]"
                  />
                )}

                <div className="flex items-center justify-between gap-2 pt-0.5">
                  {emailMode === 'login' && (
                    <button
                      type="button"
                      disabled={authBusy || !authEmail.trim()}
                      onClick={() => onResetPassword(authEmail.trim())}
                      className="bg-transparent border-0 p-0 text-[13px] text-muted hover:text-accent-bright underline cursor-pointer disabled:opacity-45"
                    >
                      忘记密码？发送重置邮件
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={authBusy}
                    className="ml-auto min-h-[38px] px-4 rounded-[8px] border border-accent/70 bg-selected text-accent-bright text-[13px] font-semibold cursor-pointer hover:bg-accent hover:text-on-accent disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    {emailMode === 'login' ? '邮箱登录并继续' : emailMode === 'register' ? '注册邮箱并继续' : '发送免密登录链接'}
                  </button>
                </div>
              </form>


            </div>
          ) : (
            <div className="p-4 rounded-[12px] border border-border bg-panel-2 flex flex-col items-stretch sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <p className="m-0 text-[14px] font-bold text-primary break-all">{email}</p>
                <p className="m-0 mt-0.5 text-[13px] text-muted">
                  {auth.currentUser?.providerData.some((p) => p.providerId === 'google.com') ? 'Google 账号登录' : '邮箱账号登录'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { onClose(); onSignOut(); }}
                className="min-h-[38px] px-4 rounded-[8px] border border-border-strong bg-transparent text-[13px] text-primary hover:border-accent cursor-pointer"
              >
                退出登录
              </button>
            </div>
          )}

          {uid && consentRequired && (
            <form onSubmit={(event) => { event.preventDefault(); if (agreed && !authBusy) onConfirmConsent(); }} className="p-4 rounded-[12px] border border-border bg-panel-2 flex flex-col gap-3">
              <p className="m-0 text-[14px] font-bold text-primary">首次使用，完成账号确认</p>
              <p className="m-0 text-[13px] text-muted">确认后即可保存档案和开始解读，之后登录无需重复确认。</p>
              <label htmlFor="auth-consent" className="flex items-start gap-2.5 pt-1 border-t border-divider text-[13px] leading-[1.55] text-secondary cursor-pointer select-none">
                <input
                  id="auth-consent" name="consent" required
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-accent cursor-pointer shrink-0"
                />
                <span>
                  我已年满 18 岁，并同意{' '}
                  <a href="/terms" onClick={(e) => { e.preventDefault(); onClose(); navigate('/terms'); }} className="underline text-accent-bright">服务条款</a>{' '}
                  与{' '}
                  <a href="/privacy" onClick={(e) => { e.preventDefault(); onClose(); navigate('/privacy'); }} className="underline text-accent-bright">隐私政策</a>
                  ；如录入亲友出生信息，确认已获对方同意。
                </span>
              </label>
              <button type="submit" disabled={authBusy} className="min-h-[44px] px-4 rounded-[8px] border-0 bg-accent text-on-accent text-[14px] font-bold cursor-pointer disabled:opacity-45">
                {authBusy ? '正在确认…' : '同意并继续'}
              </button>
            </form>
          )}

          <div className="p-4 rounded-[12px] border border-border bg-base flex flex-col gap-3">
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <p className="m-0 text-[14px] font-bold text-primary">匿名使用统计与隐私</p>
                <p className="m-0 mt-0.5 text-[13px] text-muted">允许使用匿名统计改善产品体验（默认仅必要存储）。</p>
              </div>
              <input
                type="checkbox"
                checked={analyticsEnabled}
                onChange={(e) => {
                  const granted = e.target.checked;
                  setAnalyticsEnabled(granted);
                  window.localStorage.setItem('vela_consent_choice', granted ? 'granted' : 'denied');
                  void updateAnalyticsConsent(granted);
                }}
                className="w-4 h-4 accent-accent shrink-0"
              />
            </label>
            <div className="flex items-center gap-4 pt-2 border-t border-divider text-[13px] text-muted">
              <a href="/terms" onClick={(e) => { e.preventDefault(); onClose(); navigate('/terms'); }} className="hover:text-accent-bright">服务条款</a>
              <a href="/privacy" onClick={(e) => { e.preventDefault(); onClose(); navigate('/privacy'); }} className="hover:text-accent-bright">隐私政策</a>
            </div>
          </div>

          {open && uid && !consentRequired && <ApiTokensPanel key={uid} uid={uid} />}
          {uid && !consentRequired && (
            <>
              <div className="p-4 rounded-[12px] border border-border bg-base flex flex-col items-stretch sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <p className="m-0 text-[14px] font-bold text-primary">导出个人数据</p>
                  <p className="m-0 text-[13px] text-muted">导出本人全部出生档案、咨询会话与消息为 JSON。</p>
                </div>
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={async () => {
                    setExportBusy(true);
                    setNotice(null);
                    try { await exportUserDataJson(uid); }
                    catch (err) { setNotice(formatAppError(err, '导出失败，请重试')); }
                    finally { setExportBusy(false); }
                  }}
                  className="min-h-[38px] px-4 rounded-[8px] border border-border-strong bg-panel-2 text-[13px] text-primary cursor-pointer shrink-0 disabled:opacity-45"
                >
                  {exportBusy ? '导出中…' : '导出 JSON'}
                </button>
              </div>

              <div className="p-4 rounded-[12px] border border-danger/40 bg-base flex flex-col gap-3">
                <p className="m-0 text-[14px] font-bold text-danger">删除账号（不可恢复）</p>
                <p className="m-0 text-[13px] text-secondary">输入「删除」二字确认注销账号、取消订阅并永久清除所有档案与对话。</p>
                <label htmlFor="delete-account">输入「删除」确认</label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input id="delete-account"
                    placeholder="请输入：删除"
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                    className="flex-1 min-w-0 min-h-[38px] px-3 rounded-[8px] border border-border-strong bg-panel text-primary text-[13px]"
                  />
                  <button
                    type="button"
                    disabled={deleteText !== '删除' || deleteBusy}
                    onClick={async () => {
                      setDeleteBusy(true);
                      try { await deleteUserAccount(uid); onClose(); }
                      catch (err) { setNotice(formatAppError(err, '删除失败，请重新登录后重试')); }
                      finally { setDeleteBusy(false); }
                    }}
                    className="shrink-0 min-h-[38px] px-4 rounded-[8px] border border-danger bg-transparent text-[13px] font-bold text-danger cursor-pointer disabled:opacity-40"
                  >
                    {deleteBusy ? '删除中…' : '确认删除'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
