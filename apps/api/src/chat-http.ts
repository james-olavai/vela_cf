import { turnRoutes, TurnResultSchema } from './turns.js';
import { z } from 'zod';
import { ChatRequestSchema } from '@vela-cf/shared';
export const ChatBody = ChatRequestSchema.omit({sessionId:true}).strict();
export const chatRoutes = [...turnRoutes, {
  method:'POST',path:'/v1/sessions/{id}/turns',operationId:'createTurn',body:ChatBody,status:200,stream:true,
  headers:{'Idempotency-Key':z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()},
  description:'SSE result confirms atomic message and quota commit. Idempotency-Key is scoped to user and session, binds the normalized request, and is retained for the account lifetime. Same-key completed requests return the saved result; running or failed requests return 409. GET the turn after disconnect; explicit retry after a terminal failure uses a new key. Token replay is not provided.',
  response:z.object({type:z.enum(['started','text','tool','chart','done','result','error']),turnId:z.string().optional(),text:z.string().optional(),toolName:z.string().optional(),chart:z.unknown().optional(),suggestions:z.array(z.string()).optional(),result:TurnResultSchema.optional(),error:z.object({code:z.string(),message:z.string(),requestId:z.string(),retryable:z.boolean()}).optional()}),
}];
