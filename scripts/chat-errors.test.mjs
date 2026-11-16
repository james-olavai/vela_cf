import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const source=await readFile(new URL('../apps/web/src/lib/accountStore.ts',import.meta.url),'utf8');
const compiled=await transform(source.slice(source.indexOf('export function formatAppError')),{loader:'ts',format:'esm'});
const {formatAppError}=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
test('frontend distinguishes deadline, disconnect, observer failure and explicit cancellation',()=>{
  const expected={MODEL_TIMEOUT:'时间限制',TURN_DISCONNECTED:'连接已中断',TURN_OBSERVER_FAILED:'无法确认',TURN_CANCELLED:'已取消'};
  for(const [code,message] of Object.entries(expected)){
    const error=Object.assign(new Error(code),{code});
    assert(formatAppError(error,'fallback').includes(message));
    if(code!=='TURN_CANCELLED')assert(!formatAppError(error,'fallback').includes('已取消'));
  }
  assert(formatAppError(Object.assign(new Error('upstream timeout'),{code:'functions/deadline-exceeded'}),'fallback').includes('时间限制'));
});
