import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { apiList, businessApi } from '../lib/apiClient';
import { authMethod, currentUid, reauthenticate, TOKEN_SCOPES, watchIdentity, type ApiToken, type TokenCapabilities } from '../lib/apiTokens';

const button = 'min-h-12 px-3 rounded-lg border border-border-strong bg-panel-2 text-primary cursor-pointer disabled:opacity-45';
const field = 'w-full min-w-0 min-h-12 px-3 rounded-lg border border-border-strong bg-panel text-primary text-base';
const date = (value: string | null) => value ? new Date(value).toLocaleString() : '尚未使用';
const label = (scope: string) => TOKEN_SCOPES.find(([key]) => key === scope)?.[1] || scope;
const message = (error: unknown) => {
  const code = (error as {code?: string})?.code;
  return ({PAT_DISABLED:'当前账号暂未开放创建 Token', PAT_LIMIT_REACHED:'最多可保留 5 个有效 Token，请先撤销不再使用的凭据',
    RECENT_AUTH_REQUIRED:'请先验证身份，然后再次点击创建 Token', ACCOUNT_DELETING:'账号正在删除，无法创建 Token',
    'auth/popup-closed-by-user':'已取消身份验证，未创建 Token', 'auth/cancelled-popup-request':'已取消身份验证，未创建 Token',
    'auth/popup-blocked':'浏览器阻止了验证窗口，请允许弹窗后重试', 'auth/user-mismatch':'验证账号不一致，请使用当前账号',
    'auth/wrong-password':'密码不正确，请重试', 'auth/invalid-credential':'密码不正确或登录已失效，请重试',
  } as Record<string,string>)[code || ''] || '操作未完成，请检查登录状态后重试';
};

export function ApiTokensPanel({uid}: {uid: string}) { return <TokenSession key={uid} uid={uid} />; }
function TokenSession({uid}: {uid: string}) {
  const id = useId(), life = useRef({alive:true,controller:new AbortController()}), lock = useRef(false), view = useRef(0);
  const [invalid, setInvalid] = useState(false);
  const [capability, setCapability] = useState<TokenCapabilities | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [profiles, setProfiles] = useState<Array<{id:string;name:string}> | null>(null);
  const [profilesFailed, setProfilesFailed] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<string[]>(['profiles:read']);
  const [restricted, setRestricted] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const lastCopyMessage = useRef('');
  const secretField = useRef<HTMLTextAreaElement>(null), copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeField = useRef<HTMLParagraphElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const valid = () => life.current.alive && currentUid() === uid;
  const signal = () => life.current.controller.signal;
  const report = (text: string) => { setNotice(text); requestAnimationFrame(() => noticeField.current?.focus()); };

  useEffect(() => {
    const scope = {alive:true,controller:new AbortController()};
    life.current = scope;
    const stop = () => { ++view.current; life.current.alive = false; life.current.controller.abort(); setSecret(''); setPassword(''); setInvalid(true); };
    const unsubscribe = watchIdentity(next => { if (next !== uid) stop(); });
    window.addEventListener('pagehide', stop);
    void businessApi<TokenCapabilities>(uid,'/v1/me/api-token-capabilities','GET',undefined,signal())
      .then(value => { if (valid() && life.current===scope) setCapability(value); }).catch(() => {});
    return () => { ++view.current; scope.alive=false; life.current.controller.abort(); clearTimeout(copyTimer.current); unsubscribe(); window.removeEventListener('pagehide',stop); };
  }, [uid]);

  const load = async () => {
    if (!valid()) return;
    const generation=view.current, scope=life.current, current=()=>valid() && life.current===scope && view.current===generation;
    setLoading(true); setListFailed(false); setProfilesFailed(false);
    await Promise.all([
      apiList<ApiToken>(uid,'/v1/me/api-tokens',signal()).then(value => { if (current()) setTokens(value); })
        .catch(() => { if (current()) setListFailed(true); }),
      apiList<{id:string;name:string}>(uid,'/v1/profiles',signal()).then(value => { if (current()) setProfiles(value); })
        .catch(() => { if (current()) { setProfiles(null); setProfilesFailed(true); } }),
    ]);
    if (current()) setLoading(false);
  };
  const toggle = () => {
    if (expanded) { ++view.current; setSecret(''); setPassword(''); setCopyNotice(''); setConfirm(null); }
    else void load();
    setExpanded(!expanded);
  };
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (lock.current || !valid()) return;
    lock.current=true; setBusy(true); setNotice('');
    const generation=view.current, scope=life.current;
    try { await action(() => valid() && life.current===scope && view.current===generation); }
    finally { lock.current=false; if (valid()) setBusy(false); }
  };
  const verify = () => void run(async current => {
    try { await reauthenticate(uid,password); if (current()) { setNeedsAuth(false); report('身份已验证，请点击创建 Token'); } }
    catch (error) { if (current()) report(authMethod()==='unsupported' ? '请退出后重新登录，再创建 Token' : message(error)); }
    finally { if (current()) setPassword(''); }
  });
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!capability?.canCreate || secret || loading) return;
    if (!name.trim() || !scopes.length) { report('请填写名称并选择至少一项权限'); return; }
    if (restricted && (!profiles || !selected.length || selected.some(key => !profiles.some(p => p.id===key)))) { report('请先加载档案并选择至少一个指定档案'); return; }
    void run(async current => {
      try {
        const result = await businessApi<ApiToken & {secret:string}>(uid,'/v1/me/api-tokens','POST',{
          name:name.trim(), scopes, expiresInDays:days, ...(restricted ? {profileIds:selected} : {}),
        },signal());
        if (!current()) return;
        const {secret:raw, ...metadata} = result;
        setTokens(current => [metadata,...current]); setSecret(raw); setName(''); setConfirm(null);
        requestAnimationFrame(() => secretField.current?.focus());
      } catch (error) {
        if (!current()) return;
        const code=(error as {code?:string})?.code;
        if (code==='RECENT_AUTH_REQUIRED') setNeedsAuth(true);
        if (code==='PAT_DISABLED' || code==='ACCOUNT_DELETING') setCapability(current => current && {...current,canCreate:false});
        report(code ? message(error) : '创建响应未确认，请刷新列表检查；密钥无法找回，可撤销后重新创建。不会自动重试。');
      }
    });
  };
  const revoke = (token: ApiToken) => void run(async current => {
    try {
      await businessApi(uid,`/v1/me/api-tokens/${encodeURIComponent(token.id)}`,'DELETE',undefined,signal());
      if (current()) { setConfirm(null); await load(); if (current()) report('Token 已撤销'); }
    } catch (error) { if (current()) report(message(error)); }
  });
  const copy = async () => {
    if (!valid() || !secret) return;
    const generation=view.current, scope=life.current;
    let feedback='已复制 Token';
    try { await navigator.clipboard.writeText(secret); }
    catch { feedback='复制失败，请在下方文本框中手动选择并复制'; }
    if (!valid() || life.current!==scope || generation!==view.current) return;
    clearTimeout(copyTimer.current);
    const announcement = lastCopyMessage.current===feedback ? `${feedback}\u00a0` : feedback;
    lastCopyMessage.current=announcement; setCopyNotice(announcement);
    copyTimer.current=setTimeout(() => setCopyNotice(''),5000);
  };
  useEffect(() => {
    const target=secretField.current;
    if (!target || !secret) return;
    const handle=(event: Event) => { if ((event as Event & {command:string}).command==='--copy') void copy(); };
    target.addEventListener('command',handle);
    return () => target.removeEventListener('command',handle);
  }, [secret]);

  if (invalid || !capability || (!capability.canCreate && !capability.canManage)) return null;
  return <section className="min-w-0 p-4 rounded-xl border border-border bg-base text-sm text-secondary">
    <h3 className="m-0"><button ref={trigger} type="button" className={`${button} w-full text-left font-bold`} aria-expanded={expanded} aria-controls={`${id}-content`} onClick={toggle}>开发者接入</button></h3>
    {expanded && <div id={`${id}-content`} className="mt-3 flex min-w-0 flex-col gap-4">
      <p className="m-0">为自己的脚本和 API 客户端创建访问凭据。第三方 MCP 授权尚未开放。</p>
      <p ref={noticeField} tabIndex={-1} role="status" className="m-0 text-accent-bright">{notice}</p>
      {secret ? <div className="flex flex-col gap-2 rounded-lg border border-accent p-3">
        <label htmlFor={`${id}-secret`} className="font-bold text-primary">Token 密钥（仅显示这一次）</label>
        <p className="m-0">请妥善保存；离开或关闭后无法找回。不要将它发给他人或提交到代码仓库。</p>
        <textarea ref={secretField} id={`${id}-secret`} readOnly value={secret} rows={4} spellCheck={false} autoComplete="off" className={`${field} resize-y break-all font-mono`} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} {...({command:'--copy',commandfor:`${id}-secret`} as any)} onClick={() => { if (!('CommandEvent' in window)) void copy(); }}>复制 Token</button>
          <button type="button" className={button} onClick={() => { ++view.current; setSecret(''); setCopyNotice(''); setExpanded(false); trigger.current?.focus(); }}>已保存，关闭</button>
        </div>
        <p role="status" className="m-0">{copyNotice}</p>
      </div> : capability.canCreate && <form aria-label="创建 API Token" method="post" onSubmit={create} className="flex flex-col gap-3">
        <label htmlFor={`${id}-name`}>Token 名称（必填）</label>
        <input id={`${id}-name`} name="tokenName" required maxLength={80} value={name} onChange={e => setName(e.target.value)} className={field} />
        <fieldset disabled={busy} className="border-0 p-0 m-0"><legend>有效期</legend>
          <div className="flex flex-wrap gap-4">{[7,30,90].map(value => <label key={value} htmlFor={`${id}-days-${value}`} className="flex min-h-12 items-center gap-2">
            <input id={`${id}-days-${value}`} name="expiryDays" type="radio" checked={days===value} onChange={() => setDays(value)} />{value} 天
          </label>)}</div>
        </fieldset>
        <fieldset disabled={busy} className="border-0 p-0 m-0"><legend>权限（至少选择一项）</legend>
          <p className="m-0">计算星盘、创建会话还需读取档案；发送消息还需读取会话。</p>
          <div className="grid grid-cols-1 sm:grid-cols-2">{TOKEN_SCOPES.map(([key,text]) => <label key={key} htmlFor={`${id}-${key}`} className="flex min-h-12 items-center gap-2">
            <input id={`${id}-${key}`} name="scopes" type="checkbox" checked={scopes.includes(key)} onChange={e => setScopes(current => e.target.checked ? [...current,key] : current.filter(value => value!==key))} />{text}
          </label>)}</div>
        </fieldset>
        <fieldset disabled={busy} className="border-0 p-0 m-0"><legend>档案范围</legend>
          <div className="flex flex-wrap gap-4">{[false,true].map(value => <label key={String(value)} htmlFor={`${id}-range-${value}`} className="flex min-h-12 items-center gap-2">
            <input id={`${id}-range-${value}`} name="profileRange" type="radio" checked={restricted===value} onChange={() => setRestricted(value)} />{value?'指定档案':'全部档案'}
          </label>)}</div>
          {restricted && <><p className="m-0">受限凭据不支持档案或会话列表，也不能直接传入生辰信息。</p>
            {profiles?.map(profile => <label key={profile.id} htmlFor={`${id}-profile-${profile.id}`} className="flex min-h-12 items-center gap-2">
              <input id={`${id}-profile-${profile.id}`} name="profiles" type="checkbox" checked={selected.includes(profile.id)} onChange={e => setSelected(current => e.target.checked ? [...current,profile.id] : current.filter(value => value!==profile.id))} />{profile.name}
            </label>)}
            {profiles?.length===0 && <p>暂无可授权档案，请先添加档案。</p>}
          </>}
        </fieldset>
        {needsAuth && <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="m-0">创建凭据需要近期身份验证；验证后还需点击创建。</p>
          {authMethod()==='password' && <><label htmlFor={`${id}-password`}>当前密码</label><input id={`${id}-password`} name="currentPassword" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={field} /></>}
          {authMethod()==='unsupported' ? <p>请退出后重新登录，再创建 Token。</p> : <button type="button" disabled={busy} onClick={verify} className={button}>验证身份</button>}
        </div>}
        <button type="submit" disabled={busy || loading} className={`${button} font-bold`}>{busy?'正在处理…':'创建 Token'}</button>
      </form>}
      {profilesFailed && <p role="alert">档案加载失败，指定档案的创建已阻止，请刷新重试。</p>}
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="m-0 text-primary">已有 Token</h4><button type="button" onClick={() => void load()} disabled={busy || loading} className={button}>刷新列表</button></div>
      {loading && <p>正在加载…</p>}
      {listFailed && <p role="alert">Token 列表加载失败，请刷新重试。</p>}
      {!loading && !listFailed && !tokens.length && <p>尚未创建 Token。</p>}
      <ul className="m-0 list-none p-0 space-y-3" role="list">{tokens.map(token => <li key={token.id} className="min-w-0 rounded-lg border border-border p-3 break-words">
        <p className="m-0 font-bold text-primary">{token.name}</p>
        <p>权限：{token.scopes.map(label).join('、')}</p>
        <p>档案：{token.profileIds?.map(key => profiles?.find(p => p.id===key)?.name || '已授权档案（名称不可用）').join('、') || '全部档案'}</p>
        <p>到期：{date(token.expiresAt)} · 最近使用：{date(token.lastUsedAt)}</p>
        <p>状态：{token.revokedAt?'已撤销':Date.parse(token.expiresAt)<=Date.now()?'已过期':'有效'}</p>
        {!token.revokedAt && (confirm===token.id ? <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 w-full">确认撤销「{token.name}」？使用它的客户端将无法继续访问。</p>
          <button type="button" disabled={busy} className={button} onClick={() => revoke(token)}>确认撤销 {token.name}</button>
          <button type="button" disabled={busy} className={button} onClick={() => setConfirm(null)}>取消撤销</button>
        </div> : <button type="button" disabled={busy} className={button} onClick={() => setConfirm(token.id)}>撤销 {token.name}</button>)}
      </li>)}</ul>
    </div>}
  </section>;
}
