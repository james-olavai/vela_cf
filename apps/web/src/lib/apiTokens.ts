import { EmailAuthProvider, onAuthStateChanged, reauthenticateWithCredential, reauthenticateWithPopup } from 'firebase/auth';
import { auth, googleProvider } from './firebase';

export interface ApiToken {
  id: string; name: string; prefix: string; scopes: string[]; profileIds?: string[];
  createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null;
}
export interface TokenCapabilities { canCreate: boolean; canManage: boolean }
export const TOKEN_SCOPES = [
  ['profiles:read', '读取档案'], ['charts:compute', '计算星盘'], ['sessions:read', '读取会话'],
  ['sessions:create', '创建会话'], ['turns:write', '发送消息'], ['usage:read', '查看额度'],
] as const;
export const currentUid = () => auth.currentUser?.uid ?? null;
export const watchIdentity = (listener: (uid: string | null) => void) => onAuthStateChanged(auth, user => listener(user?.uid ?? null));
export function authMethod(): 'google' | 'password' | 'unsupported' {
  const providers = auth.currentUser?.providerData.map(provider => provider.providerId) || [];
  return providers.includes('google.com') ? 'google' : providers.includes('password') ? 'password' : 'unsupported';
}
export async function reauthenticate(uid: string, password = ''): Promise<void> {
  const user = auth.currentUser;
  if (!user || user.uid !== uid) throw new Error('登录状态已改变，请重新打开设置');
  const method = authMethod();
  if (method === 'google') await reauthenticateWithPopup(user, googleProvider);
  else if (method === 'password' && user.email) await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  else throw new Error('请退出后重新登录，再创建 Token');
  if (auth.currentUser !== user || user.uid !== uid) throw new Error('登录状态已改变，请重新打开设置');
  await user.getIdToken(true);
  if (auth.currentUser !== user || user.uid !== uid) throw new Error('登录状态已改变，请重新打开设置');
}
