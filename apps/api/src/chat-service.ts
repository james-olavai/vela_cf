import { createHash } from 'node:crypto';
import { beginTurn, failTurn, turnRef } from './turns.js';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { ChatRequestSchema, computeTokenCostMicroUsd, TIER_META, type Tier } from '@vela-cf/shared';
import type { generateReading } from './generate-reading.js';
import { defaultBundle } from './prompt-bundle.js';
import { resolveSubjects } from './subjects.js';
import { acquireSessionTurn, commitSessionTurn, releaseSessionTurn } from './session.js';
import { resolveUserPeriodAndTier, reserveQuota, releaseQuota } from './quota.js';
function assertTierSubjects(profiles: any[], tier: Tier) {
  if(profiles.some(p=>p.entityType && p.entityType!=='person') && !TIER_META[tier].allowsEntityCharts)throw new HttpsError('permission-denied','ENTITY_CHART_REQUIRES_PRO');
  if(profiles.length>1 && profiles.length>TIER_META[tier].maxSynastryProfiles)throw new HttpsError('permission-denied','INVALID_SYNASTRY_PROFILE_COUNT');
}
export function createChatRunner(db: Firestore, generate: (input: Parameters<typeof generateReading>[1], emit: (chunk: any)=>void) => ReturnType<typeof generateReading>, authorize?: (context: any, sessionId: string) => Promise<void>, authorizeCommit?: (tx:Transaction, context:any) => Promise<void>) {
return async (rawInput: unknown, context: any, sendChunk: (chunk: any) => void, signal?: AbortSignal) => {
    signal = signal ? AbortSignal.any([signal,AbortSignal.timeout(150_000)]) : AbortSignal.timeout(150_000);
    const turnId = context?.turnId || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let quotaRequestId = '';
    let uid: string | undefined;
    let sessionId: string | undefined;
    let sessionLockAcquired = false;
    let quotaReserved = false;
    let durableStarted = false;
    let unwatch: (()=>void) | undefined;

    try {
      const input = ChatRequestSchema.parse(rawInput);
      uid = context?.auth?.uid;
      sessionId = input.sessionId;
      quotaRequestId = createHash('sha256').update(`${sessionId}:${turnId}`).digest('hex');
      if (!uid) {
        throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
      }

      if (context?.turnId) {
        const existing=await beginTurn(db,uid,input.sessionId,turnId,input);
        if(existing){
          if(existing.status==='completed'){sendChunk({type:'done',suggestions:existing.result.suggestions});return existing.result;}
          throw new HttpsError('already-exists',existing.status==='running'?'TURN_RUNNING':existing.status==='cancelled'?'TURN_CANCELLED':'TURN_FAILED');
        }
        durableStarted=true;
        const cancel=new AbortController();signal=AbortSignal.any([signal,cancel.signal]);
        unwatch=turnRef(db,uid,input.sessionId,turnId).onSnapshot(snap=>{
          if(snap.data()?.status==='cancelled')cancel.abort(new HttpsError('aborted','TURN_CANCELLED'));
          if(snap.data()?.status==='failed')cancel.abort(new HttpsError('aborted','TURN_INTERRUPTED'));
        },()=>cancel.abort(new HttpsError('unavailable','TURN_OBSERVER_FAILED')));
        sendChunk({type:'started',turnId});
        signal.throwIfAborted();
      }

      const { session, historyContext, replacedMessageIds } = await acquireSessionTurn(db, {
        uid,
        sessionId: input.sessionId,
        turnId,
        editLastTurn: input.editLastTurn,
        lockTtlMs: 240_000,
      });
      sessionLockAcquired = true;

      const sessionRef = db.collection('users').doc(uid).collection('sessions').doc(input.sessionId);
      let frozenSubjects = session.frozenSubjects as any[] | undefined;
      if (!Array.isArray(frozenSubjects) || !frozenSubjects.length) {
        const ids = Array.isArray(session.profileIds) ? session.profileIds : [session.profileId];
        frozenSubjects = await resolveSubjects(db, uid, ids.map((id: string) => ({ref:id,profile_id:id})));
        await sessionRef.update({frozenSubjects});
      }
      const profiles = frozenSubjects.map((subject: any) => ({...subject.profile,...(subject.countryChart?{countryChart:subject.countryChart}:{})}));

      const { tier, periodStart, unlimited } = await resolveUserPeriodAndTier(
        db,
        uid,
        context?.auth?.token?.stripeRole,
      );
      assertTierSubjects(profiles,tier);
      await reserveQuota(db, {
        uid,
        tier,
        periodStart,
        unlimited,
        ttlMs: 240_000,
        requestId: quotaRequestId,
      });
      quotaReserved = true;

      const userCreatedAt = new Date().toISOString();
      const frozen = await db.collection('users').doc(uid).collection('sessions').doc(input.sessionId).collection('private').doc('prompt').get();
      const bundle = { ...defaultBundle(tier), ...(frozen.data()?.bundle as object || {}),
        systemPrompt: String(session.frozenPrompt || defaultBundle(tier).systemPrompt),
        modelName: String(session.frozenModel || defaultBundle(tier).modelName),
        allowedTools: Array.isArray(session.frozenTools) ? session.frozenTools : ['natalWheel'],
      };
      signal.throwIfAborted();
      const generated = await generate( { bundle, tier, profiles, message: input.message,
        historyContext, mode: String(session.mode), depth: input.depth, signal }, sendChunk);
      signal?.throwIfAborted();
      const { text: cleanText, uiBlocks, suggestions, toolParts } = generated;
      if(!cleanText.trim())throw new HttpsError('unavailable','EMPTY_MODEL_RESPONSE');
      sendChunk({type:'chart',chart:generated.chart});
      const usageMeta = generated.usage;
      const inTokens = Number(usageMeta?.inputTokens ?? 0);
      const outTokens = Number(usageMeta?.outputTokens ?? 0) + Number(usageMeta?.thoughtsTokens ?? 0);
      const costMicroUsd =
        inTokens > 0 || outTokens > 0 ? computeTokenCostMicroUsd(inTokens, outTokens) : 30_000;

      const assistantParts = [
        ...toolParts,
        ...(cleanText ? [{ type: 'text', text: cleanText }] : []),
        ...uiBlocks,
      ];

      // authorize and auth are supplied by the server, never by the request body.
      await authorize?.(context,input.sessionId);
      if(authorize)assertTierSubjects(profiles,(await resolveUserPeriodAndTier(db,uid,context?.auth?.token?.stripeRole)).tier);
      signal.throwIfAborted();
      await commitSessionTurn(db, {
        signal,
        authorize: authorizeCommit ? tx=>authorizeCommit(tx,context) : undefined,
        uid,
        sessionId: input.sessionId,
        turnId,
        replacedMessageIds,
        settlement:{periodStart,costMicroUsd,requestId:quotaRequestId},
        ...(durableStarted?{durableResult:{text:cleanText,suggestions,uiBlocks}}:{}),
        userMessage: {
          text: input.message,
          createdAt: userCreatedAt,
        },
        assistantMessage: {
          parts: assistantParts,
          suggestions,
          createdAt: new Date().toISOString(),
        },
      });
      sessionLockAcquired = false;

      quotaReserved = false;

      sendChunk({ type: 'done', suggestions });
      return { text: cleanText, suggestions, uiBlocks };
    } catch (err) {
      const reason=signal.aborted ? signal.reason : err;
      const error=reason?.name==='TimeoutError' ? new HttpsError('deadline-exceeded','MODEL_TIMEOUT')
        : signal.aborted && !(reason instanceof HttpsError) ? new HttpsError('aborted','TURN_DISCONNECTED') : reason;
      if(durableStarted && uid && sessionId)await failTurn(db,uid,sessionId,turnId,error instanceof HttpsError && ['MODEL_TIMEOUT','TURN_CANCELLED','TURN_DISCONNECTED','TURN_INTERRUPTED','TURN_OBSERVER_FAILED'].includes(error.message) ? error.message : 'TURN_FAILED').catch(()=>undefined);
      if (uid && quotaReserved) {
        await releaseQuota(db, { uid, requestId: quotaRequestId }).catch(() => undefined);
      }
      if (uid && sessionId && sessionLockAcquired) {
        await releaseSessionTurn(db, { uid, sessionId, turnId }).catch(() => undefined);
      }
      throw error;
    } finally { unwatch?.(); }
}

}
