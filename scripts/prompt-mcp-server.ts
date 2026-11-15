// Local-only entry. Never imported by the production Functions bundle.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { genkit } from 'genkit';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROMPT_TEXT } from '../apps/api/src/prompt-resources.generated.js';
import { defaultBundle, parseCompleteBundle, bundleHash } from '../apps/api/src/prompt-bundle.js';
import { generateReading } from '../apps/api/src/generate-reading.js';
import { registerHydrogenGateway, HYDROGEN_GATEWAY_MODEL } from '../apps/api/src/gateway-model.js';
import { NatalWheelInputSchema } from '../packages/astrology/src/index.js';
import { pathToFileURL } from 'node:url';
import { createEvaluationJobs, confinedFile, digest } from './prompt-mcp-jobs.mjs';
async function main() {
const root = resolve(process.env.VELA_TUNING_ROOT || process.cwd()), standalone=!!process.env.VELA_TUNING_ROOT;
const resourceRoot = resolve(root, process.env.VELA_PROMPT_SNAPSHOTS || (standalone ? '.vela/snapshots' : '.playground/prompt-snapshots'));
const {compilePromptResources}=await import(pathToFileURL(resolve(root,standalone?'runtime/compiler.mjs':'scripts/prompt-build.mjs')).href);
const caseRoot=resolve(root,standalone?'cases':'apps/api/playground-fixtures');
const readJSON = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const catalog = await readJSON(resolve(caseRoot,'catalog.json'));
const products = await readJSON(resolve(caseRoot,'products.json'));
const fixtures = (await readJSON(resolve(caseRoot,'fixed-results.json'))).entries;
await mkdir(resourceRoot, { recursive: true });
function git(args: string[]) { try { return execFileSync('git', args, { cwd:root, encoding:'utf8', stdio:['ignore','pipe','ignore'], maxBuffer:4_000_000 }).trim(); } catch { return 'unknown'; } }
const metadata=standalone?await readJSON(resolve(root,'runtime.lock.json')):null;
const runtimeCommit = metadata?.runtimeCommit || git(['rev-parse','HEAD']);
// Store a digest of dirty runtime state, never the potentially sensitive diff itself.
async function runtimeFiles(dir: string):Promise<Array<[string,string]>> {
  const entries=await readdir(resolve(root,dir),{withFileTypes:true});
  const out:Array<[string,string]>=[];
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=`${dir}/${entry.name}`;
    if(entry.isDirectory()) out.push(...await runtimeFiles(path));
    else if(entry.isFile() && /\.(ts|mjs|json)$/.test(entry.name)) out.push([path,await readFile(resolve(root,path),'utf8')]);
  }
  return out;
}
const runtimeDiffHash = metadata?.runtimeSourceHash || metadata?.runtimeHash || metadata?.runtimeDiffHash || digest((await Promise.all(['apps/api/src','scripts','packages/astrology/src','packages/shared/src'].map(runtimeFiles))).flat());
const productFor = (id: string) => { const p = products.find((p: any) => p.id === id); if (!p) throw new Error('未找到产品'); return p; };
async function loadBundle(productId: string, snapshot?: string) {
  const p = productFor(productId);
  const resources=standalone&&!snapshot?await compilePromptResources(resolve(root,'prompts')):null;
  const base=defaultBundle(p.tier,p.id);
  const b = snapshot ? parseCompleteBundle(await readJSON(await confinedFile(resourceRoot, snapshot))) : resources ? parseCompleteBundle({...base,systemPrompt:resources.systemPrompts[p.id] || resources.systemPrompts[p.tier],skills:resources.skills,toolDescriptions:resources.toolDescriptions,templates:resources.templates,outputInstructions:resources.outputInstructions,revision:resources.revision}) : base;
  if (b.productId !== productId) throw new Error('快照产品与请求不一致');
  return {bundle:b,routingText:resources?.routing || PROMPT_TEXT.routing,sourceHash:resources?.sourceHash || (snapshot?null:PROMPT_TEXT.sourceHash)};
}
const startSchema = z.object({ productId:z.string().max(100), snapshot:z.string().max(200).optional(), caseIds:z.array(z.string().max(100)).min(1).max(8), repeats:z.number().int().min(1).max(3).default(1), toolMode:z.enum(['live','fixture']).default('live'), maxOutputTokens:z.number().int().min(1024).max(16384).default(16384), timeoutMs:z.number().int().min(1000).max(600000).default(180000) }).strict();
function casesFor(ids: string[], tier: string) {
  return ids.map(id => {
    const item = catalog.cases.find((c: any) => c.id === id); if (!item) throw new Error(`未找到案例 ${id}`);
    const profiles = item.profileIds.map((id: string) => catalog.profiles.find((p: any) => p.id === id));
    if (profiles.length > (tier === 'pro' ? 4 : tier === 'go' ? 2 : 1)) throw new Error('产品不支持案例档案数量');
    for (const p of profiles) { NatalWheelInputSchema.parse(p); if (tier !== 'pro' && p.entityType && p.entityType !== 'person') throw new Error('档位不支持此实体'); }
    z.array(z.object({role:z.enum(['user','assistant']),text:z.string().max(20000)})).max(20).parse(item.history || []);
    if (typeof item.message !== 'string' || !item.message.trim() || item.message.length > 2000) throw new Error('案例问题不符合生产限制');
    return { ...item, profiles, referenceTime:z.string().datetime().parse(item.referenceTime || catalog.provenance.referenceTime) };
  });
}
const jobs = await createEvaluationJobs({ directory:resolve(root,standalone?'.vela/jobs':'.playground/mcp-jobs'),
  prepare:async (raw: unknown) => {
    const input = startSchema.parse(raw), p = productFor(input.productId), loaded = await loadBundle(input.productId,input.snapshot), bundle=loaded.bundle;
    if (bundle.modelName !== HYDROGEN_GATEWAY_MODEL && !bundle.modelName.endsWith('/gemini-4-hydrogen')) throw new Error('本地连接只登记 Hydrogen 模型，请显式选择对应快照');
    const requestedModel = bundle.modelName; bundle.modelName = HYDROGEN_GATEWAY_MODEL;
    if (!process.env.LLM_GATEWAY_TOKEN) throw new Error('未配置本地模型凭据');
    return { ...input, bundle,routingText:loaded.routingText,tier:p.tier,cases:casesFor(input.caseIds,p.tier),provenance:{ runtimeCommit,runtimeDiffHash,runtimeMetadata:metadata,requestedModel,promptCommit:null,promptContentHash:digest({bundle,routingText:loaded.routingText}),bundleHash:bundleHash(bundle),schemaVersion:1,runtimeContractVersion:1,catalogRevision:catalog.revision, promptSource:input.snapshot?'local-snapshot':standalone?'workspace-prompts':'compiled-default',sourceHash:loaded.sourceHash, snapshotFile:input.snapshot||null,price:'unknown' }, fixtures:input.toolMode==='fixture'?fixtures:undefined };
  },
  evaluate:async (snapshot: any,item: any,signal: AbortSignal) => {
    const ai=genkit({plugins:[]}),responses:unknown[]=[];
    registerHydrogenGateway(ai,{token:process.env.LLM_GATEWAY_TOKEN!,baseUrl:process.env.LLM_GATEWAY_URL,maxOutputTokens:snapshot.maxOutputTokens,signal,onResponse:r=>responses.push(r)});
    const result=await generateReading(ai,{bundle:{...snapshot.bundle,modelName:HYDROGEN_GATEWAY_MODEL},routingText:snapshot.routingText,tier:snapshot.tier,profiles:item.profiles,message:item.message,historyContext:item.history?.map((m:any)=>`${m.role==='user'?'用户':'顾问'}：${m.text}`).join('\n'),mode:item.mode,depth:item.depth,referenceTime:item.referenceTime,toolMode:snapshot.toolMode,fixtures:snapshot.fixtures,signal});
    return {...result, gateway:{maxOutputTokens:snapshot.maxOutputTokens,responses}};
  }
});
const server=new McpServer({name:'vela-prompt-evaluation',version:'0.1.0'});
const reply=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
function register(name:string,description:string,shape:any,handler:(input:any)=>Promise<any>|any) {
  server.registerTool(name,{description,inputSchema:shape},async input=>{try{return reply(await handler(input));}catch(error){const text=error instanceof Error && !('code' in error)?error.message:'请检查本地资源、连接与权限';return {isError:true,content:[{type:'text' as const,text:`操作失败：${text.slice(0,500)}`}]};}});
}
register('inspect_product','查看产品、内置案例与初始请求；不调用模型。', {productId:z.string().optional(),snapshot:z.string().optional(),caseId:z.string().optional()},async input=>{
  if (!input.productId) return {products,cases:catalog.cases.map((c:any)=>({id:c.id,title:c.title})),status:'本地候选；未发布'};
  const p=productFor(input.productId),loaded=await loadBundle(p.id,input.snapshot),bundle=loaded.bundle;
  const preview=input.caseId?await generateReading(genkit({plugins:[]}),{bundle,routingText:loaded.routingText,tier:p.tier,...casesFor([input.caseId],p.tier)[0],historyContext:casesFor([input.caseId],p.tier)[0].history?.map((m:any)=>`${m.role==='user'?'用户':'顾问'}：${m.text}`).join('\n'),previewOnly:true}):undefined;
  return {product:p,bundle,routingText:loaded.routingText,sourceHash:loaded.sourceHash,hash:bundleHash(bundle),preview,notes:['初始事实由真实排盘计算；后续工具响应尚未发生','源码不可替代完整模型每轮上下文；当前生成诊断尚未记录每轮请求'],runtimeCommit,runtimeDiffHash};
});
register('start_evaluation','创建固定快照的异步评测。最多8案例、3次重复、单任务串行。',startSchema.shape,input=>jobs.start(input));
register('get_evaluation','分页读取评测进度、回答和诊断。',{jobId:z.string().uuid(),cursor:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(5).default(1)},input=>jobs.get(input.jobId,input.cursor,input.limit));
register('cancel_evaluation','取消排队/在途评测，已发生费用无法撤销。',{jobId:z.string().uuid()},input=>jobs.cancel(input.jobId));
register('compare_evaluations','比较两次评测，返回A/B文本与可比条件检查，等待人工评价。',{left:z.string().uuid(),right:z.string().uuid()},input=>jobs.compare(input.left,input.right));
await server.connect(new StdioServerTransport());

}
main().catch(()=>{console.error("本地MCP启动失败；请检查资源、依赖和本地配置");process.exitCode=1;});
