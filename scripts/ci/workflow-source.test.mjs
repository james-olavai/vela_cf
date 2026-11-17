import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertProducer,assertProvenance,extractArchive,prepareWorkflow} from './workflow-source.mjs';
import {artifactHashes,codeIdentity} from './artifact.mjs';

const sha='a'.repeat(40),repository='admin/vela-cf';
function producer(workflow='ci.yml',name='ci'){
  const run={id:12,run_number:5,path:`${workflow}@refs/heads/main`,repository:{full_name:repository},head_branch:'main',head_sha:sha,event:'push',status:'completed',conclusion:'success'};
  const jobs=[{run_id:12,head_sha:sha,name,status:'completed',conclusion:'success',run_attempt:1}];
  return {run,jobs};
}
test('Upstream evidence requires the exact successful main producer, not an overall run success',()=>{
  const {run,jobs}=producer();assertProducer(run,jobs,'build',repository);
  for(const patch of [{repository:{full_name:'other/repo'}},{head_branch:'feature'},{event:'pull_request'},{event:'pull_request_target'},{path:'evil.yml@refs/heads/main'},{head_sha:'bad'}])assert.throws(()=>assertProducer({...run,...patch},jobs,'build',repository));
  for(const patch of [{run_id:99},{head_sha:'b'.repeat(40)},{name:'other'},{status:'running'},{conclusion:'failure'},{conclusion:'skipped'}])assert.throws(()=>assertProducer(run,[{...jobs[0],...patch}],'build',repository));
  assert.throws(()=>assertProducer(run,[...jobs,...jobs],'build',repository));
  const legacy=producer('ci.yml','3. 在线验收测试环境');legacy.run.conclusion='failure';
  assertProducer(legacy.run,legacy.jobs,'verify',repository);
  legacy.jobs[0].conclusion='failure';assert.throws(()=>assertProducer(legacy.run,legacy.jobs,'verify',repository));
  const split=producer('verify-staging.yml','verify-staging');assertProducer(split.run,split.jobs,'verify',repository);
  split.run.conclusion='failure';assert.throws(()=>assertProducer(split.run,split.jobs,'verify',repository));
  assert.throws(()=>assertProducer(run,jobs,'verify',repository));
});
test('Cross-workflow provenance cannot point to another commit or an invalid build run',()=>{
  const value={schema:1,sha,buildRun:5};assertProvenance(value,sha);
  for(const patch of [{schema:2},{sha:'b'.repeat(40)},{buildRun:'5'},{buildRun:-1},{buildRun:0}])assert.throws(()=>assertProvenance({...value,...patch},sha));
});
test('ZIP and TAR traversal, links and duplicate entries are rejected before extraction',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vela-archive-test-'));
  try{
    for(const kind of ['zip','tar'])for(const type of ['traversal','absolute','link','duplicate']){
      const file=join(dir,`${kind}-${type}`),dest=join(dir,`out-${kind}-${type}`);
      execFileSync('python3',['-c',String.raw`
import sys, zipfile, tarfile, io, stat
file, kind, attack = sys.argv[1:]
name = '../escape' if attack == 'traversal' else '/escape' if attack == 'absolute' else 'entry'
if kind == 'zip':
    with zipfile.ZipFile(file, 'w') as a:
        e = zipfile.ZipInfo(name)
        if attack == 'link': e.external_attr = (stat.S_IFLNK | 0o777) << 16
        a.writestr(e, 'data')
        if attack == 'duplicate': a.writestr(e, 'data')
else:
    with tarfile.open(file, 'w:gz') as a:
        e = tarfile.TarInfo(name)
        if attack == 'link': e.type = tarfile.SYMTYPE; e.linkname = '../escape'
        else: e.size = 4
        a.addfile(e, io.BytesIO(b'data'))
        if attack == 'duplicate': a.addfile(e, io.BytesIO(b'data'))
`,file,kind,type],{stdio:'pipe'});
      assert.throws(()=>extractArchive(file,dest,kind));
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Independent workflows fetch one immutable build and preserve the deployment lease; failed source blocks promotion',async()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),'vela-source-test-'));
  const git=args=>execFileSync('git',args,{cwd:dir,stdio:'pipe',encoding:'utf8'}).trim();
  git(['init','-b','main']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);
  writeFileSync(join(dir,'tracked'),'candidate');git(['add','tracked']);git(['commit','-m','candidate']);
  const commit=git(['rev-parse','HEAD']);git(['update-ref','refs/remotes/origin/main',commit]);
  const payload=join(dir,'payload');mkdirSync(payload);writeFileSync(join(payload,'code'),'tested');
  const hashes=artifactHashes(payload);writeFileSync(join(payload,'manifest.json'),JSON.stringify({sha:commit,hashes,...codeIdentity(hashes)}));
  execFileSync('tar',['-czf',join(dir,'release.tar.gz'),'-C',payload,'.']);
  const zip=files=>{
    const output=join(dir,'upload.zip');
    execFileSync('python3',['-c','import sys,json,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n for name,path in json.loads(sys.argv[2]).items(): z.write(path,name)',output,JSON.stringify(files)]);
    return readFileSync(output);
  };
  const release=zip({'release.tar.gz':join(dir,'release.tar.gz')});
  const base=producer();base.run.head_sha=commit;base.jobs[0].head_sha=commit;
  const deploy=producer('deploy-staging.yml','deploy-staging');deploy.run.id=13;deploy.run.run_number=6;deploy.run.head_sha=commit;deploy.jobs[0]={...deploy.jobs[0],head_sha:commit,run_id:13};
  writeFileSync(join(dir,'deployment.json'),JSON.stringify({sha:commit,status:'deployed',environment:'staging',owner:'run-13-1'}));
  writeFileSync(join(dir,'workflow-source.json'),JSON.stringify({schema:1,sha:commit,buildRun:5}));
  const deployment=zip({'deployment.json':join(dir,'deployment.json'),'workflow-source.json':join(dir,'workflow-source.json')});
  const verify=producer('verify-staging.yml','verify-staging');verify.run.id=14;verify.run.run_number=7;verify.run.head_sha=commit;verify.jobs[0]={...verify.jobs[0],head_sha:commit,run_id:14};
  writeFileSync(join(dir,'release-result.json'),JSON.stringify({sha:commit,status:'verified',environment:'staging'}));
  const evidence=zip({'release-result.json':join(dir,'release-result.json'),'workflow-source.json':join(dir,'workflow-source.json')});
  const all=[base,deploy,verify],downloads=[];
  const server=createServer((req,res)=>{
    const path=req.url.split('?')[0];res.setHeader('Content-Type','application/json');
    // Actual Gitea 1.25 policy: listing runs is owner-only. The reader token
    // must resolve UI numbers without calling this privileged endpoint.
    if(path.endsWith('/actions/runs')){res.statusCode=403;return res.end('{}');}
    const view=all.find(p=>path.endsWith(`/runs/${p.run.run_number}/jobs/0`));
    if(view){
      if(req.method==='GET'){res.setHeader('Set-Cookie','csrf=test-cookie; HttpOnly');return res.end('<script>csrfToken: "test-csrf"</script>');}
      assert.equal(req.method,'POST');assert.equal(req.headers['x-csrf-token'],'test-csrf');assert.equal(req.headers.cookie,'csrf=test-cookie');
      return res.end(JSON.stringify({state:{run:{jobs:[{id:100+view.run.id}]}}}));
    }
    const job=all.find(p=>path.endsWith(`/actions/jobs/${100+p.run.id}`));if(job)return res.end(JSON.stringify({run_id:job.run.id}));
    const run=all.find(p=>path.endsWith(`/actions/runs/${p.run.id}`));if(run)return res.end(JSON.stringify(run.run));
    const p=all.find(p=>path.endsWith(`/runs/${p.run.id}/jobs`));if(p)return res.end(JSON.stringify({jobs:p.jobs}));
    downloads.push(path);
    if(path.endsWith(`/5/artifacts/release-${commit}`))return res.end(release);
    if(path.endsWith('/6/artifacts/staging-deployment'))return res.end(deployment);
    if(path.endsWith('/7/artifacts/staging-verified-evidence'))return res.end(evidence);
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const env={GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:repository,GITHUB_SERVER_URL:`http://127.0.0.1:${server.address().port}`,GITHUB_RUN_ID:'20',GITHUB_ENV:join(dir,'env')};
  try{
    process.chdir(dir);
    for(const [phase,source,owner] of [['deploy','5','run-20-1'],['verify','6','run-13-1'],['production','7','run-20-1']]){
      rmSync('.release',{recursive:true,force:true});rmSync('artifacts',{recursive:true,force:true});
      await prepareWorkflow(phase,source,env);
      assert(readFileSync(env.GITHUB_ENV,'utf8').endsWith(`CI_COMMIT_SHA=${commit}\nCI_RELEASE_ID=${owner}\n`));
      assert.equal(JSON.parse(readFileSync('.release/manifest.json','utf8')).sha,commit);
    }
    assert.equal(downloads.filter(p=>p.endsWith(`/release-${commit}`)).length,3);
    verify.jobs[0].conclusion='failure';
    const count=downloads.length;await assert.rejects(prepareWorkflow('production','7',env),/did not succeed/);assert.equal(downloads.length,count);
    await assert.rejects(prepareWorkflow('deploy','5',{...env,GITHUB_REF:'refs/heads/feature'}),/main/);
    await assert.rejects(prepareWorkflow('deploy','5;echo bad',env),/positive/);
  }finally{process.chdir(cwd);await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
