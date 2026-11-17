// Cross-workflow inputs are Gitea UI run numbers, never arbitrary artifact URLs.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateArtifact} from './artifact.mjs';

const producers={
  build:{workflow:'ci.yml',job:'ci'},
  deploy:{workflow:'deploy-staging.yml',job:'deploy-staging',legacy:'2. 部署测试环境'},
  verify:{workflow:'verify-staging.yml',job:'verify-staging',legacy:'3. 在线验收测试环境'},
};
export function assertProducer(run,jobs,stage,repository){
  const p=producers[stage];assert(p,'Unknown producer stage');
  assert.equal(run.repository?.full_name,repository,'Wrong source repository');
  assert.equal(run.head_branch,'main','Source must run on main');
  assert(['push','workflow_dispatch'].includes(run.event),'Pull requests and tags cannot release');
  assert(/^[a-f0-9]{40}$/.test(run.head_sha),'Invalid source commit');
  const workflow=run.path?.split('@')[0];
  const legacy=workflow==='ci.yml';
  assert(workflow===p.workflow || legacy,'Wrong source workflow');
  const name=legacy&&stage!=='build'?p.legacy:p.job;
  const matches=jobs.filter(j=>j.run_id===run.id && j.head_sha===run.head_sha && j.name===name);
  assert.equal(matches.length,1,'Missing or ambiguous producer job');
  const job=matches[0];
  assert(job.status==='completed'&&job.conclusion==='success','Producer job did not succeed');
  // A later job may fail in the old combined workflow; successful stage evidence remains valid.
  if(!legacy)assert(run.status==='completed'&&run.conclusion==='success','Producer workflow did not succeed');
  return {legacy,job};
}
export function assertProvenance(value,sha){
  assert.equal(value?.schema,1,'Missing source provenance');
  assert.equal(value.sha,sha,'Source provenance commit mismatch');
  assert(Number.isSafeInteger(value.buildRun)&&value.buildRun>0,'Invalid build run');
  return value;
}

// Python's standard library validates all entries before writing any extracted files.
export function extractArchive(file,destination,kind){
  execFileSync('python3',['-c',String.raw`
import sys, zipfile, tarfile, pathlib, stat
file, dest, kind = sys.argv[1:]
root = pathlib.Path(dest).resolve()
with (zipfile.ZipFile(file) if kind == 'zip' else tarfile.open(file, 'r:gz')) as archive:
    entries = archive.infolist() if kind == 'zip' else archive.getmembers()
    assert len(entries) <= 30000, 'Too many archive entries'
    total = 0
    seen = set()
    for entry in entries:
        name = entry.filename if kind == 'zip' else entry.name
        path = pathlib.PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts and '\\' not in name, 'Unsafe archive path'
        target = root.joinpath(*path.parts).resolve()
        assert target == root or root in target.parents, 'Archive escapes destination'
        assert target not in seen, 'Duplicate archive entry'
        seen.add(target)
        if kind == 'zip':
            mode = entry.external_attr >> 16
            assert not stat.S_ISLNK(mode) and (stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)), 'Unsafe ZIP type'
            total += entry.file_size
        else:
            assert entry.isfile() or entry.isdir(), 'Unsafe TAR type'
            total += entry.size
    assert total <= 512 * 1024 * 1024, 'Archive too large'
    root.mkdir(parents=True, exist_ok=True)
    archive.extractall(root)
`,file,destination,kind],{stdio:['ignore','pipe','pipe']});
}

export async function prepareWorkflow(phase,sourceNumber,env=process.env){
  assert(['deploy','verify','production'].includes(phase),'Unknown release phase');
  assert.equal(env.GITHUB_REF,'refs/heads/main','Dispatch release workflows on main');
  assert(/^[1-9][0-9]*$/.test(sourceNumber),'source_run must be a positive Gitea UI run number');
  const repository=env.GITHUB_REPOSITORY;
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository),'Invalid repository');
  const server=new URL(env.GITHUB_SERVER_URL);
  assert(['http:','https:'].includes(server.protocol)&&!server.username&&!server.password,'Invalid Gitea server');
  const headers=env.GITEA_TOKEN?{Authorization:`token ${env.GITEA_TOKEN}`} : {};
  async function request(path,json=true,options={}){
    const response=await fetch(new URL(path,server),{...options,headers:{...headers,...options.headers},redirect:'error',signal:AbortSignal.timeout(120000)});
    assert(response.ok,`Source download failed: HTTP ${response.status}`);
    if(json==='response')return response;
    if(json)return response.json();
    assert(Number(response.headers.get('content-length')||0)<=256*1024*1024,'Download too large');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;assert(size<=256*1024*1024,'Download too large');chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  const api=`/api/v1/repos/${repository}`;
  async function producer(number,stage){
    // Gitea 1.25's run LIST requires repo ownership; individual run/job GETs only
    // require Actions read access. Resolve the UI number using its read-only view,
    // then trust only the canonical API metadata below. No owner PAT is needed.
    assert(Number.isSafeInteger(Number(number))&&Number(number)>0,'Invalid source run');
    const viewPath=`/${repository}/actions/runs/${number}/jobs/0`;
    const page=await request(viewPath,'response'),html=await page.text();
    const csrf=html.match(/csrfToken:\s*['"]([^'"]+)/)?.[1]||html.match(/name="_csrf" content="([^"]+)/)?.[1];
    assert(csrf,'Cannot read Gitea run view');
    const cookie=page.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    // This POST only reads the view state with no log cursors; it never reruns,
    // cancels, approves or otherwise changes a workflow.
    const view=await request(viewPath,true,{method:'POST',headers:{'Content-Type':'application/json','X-Csrf-Token':csrf,Cookie:cookie},body:JSON.stringify({logCursors:[]})});
    const jobId=view.state?.run?.jobs?.[0]?.id;
    assert(Number.isSafeInteger(jobId)&&jobId>0,'Missing source job');
    const job=await request(`${api}/actions/jobs/${jobId}`);
    assert(Number.isSafeInteger(job.run_id)&&job.run_id>0,'Missing source run ID');
    const run=await request(`${api}/actions/runs/${job.run_id}`);
    assert.equal(run.run_number,Number(number),'Run view and API number mismatch');
    const {jobs}=await request(`${api}/actions/runs/${run.id}/jobs`);
    return {...assertProducer(run,jobs,stage,repository),run};
  }
  const dir=mkdtempSync(join(tmpdir(),'vela-workflow-source-'));
  try{
    async function download(source,name,to){
      const file=join(dir,`${name}.zip`);
      writeFileSync(file,await request(`/${repository}/actions/runs/${source.run.run_number}/artifacts/${name}`,false));
      extractArchive(file,to,'zip');
    }
    const source=await producer(sourceNumber,phase==='deploy'?'build':phase==='verify'?'deploy':'verify');
    let sha,buildRun,evidence;
    if(phase==='deploy'){sha=source.run.head_sha;buildRun=source.run.run_number;}
    else{
      const name=phase==='verify'?'staging-deployment':'staging-verified-evidence';
      const path=join(dir,'evidence');
      await download(source,name+(source.legacy?`-${source.run.head_sha}`:''),path);
      evidence=JSON.parse(readFileSync(join(path,phase==='verify'?'deployment.json':'release-result.json'),'utf8'));
      sha=evidence.sha;
      buildRun=source.legacy?source.run.run_number:assertProvenance(JSON.parse(readFileSync(join(path,'workflow-source.json'),'utf8')),sha).buildRun;
      assert.equal(evidence.status,phase==='verify'?'deployed':'verified','Source evidence did not pass');
      assert.equal(evidence.environment,'staging','Source evidence is not staging');
      if(source.legacy)assert.equal(sha,source.run.head_sha,'Legacy source commit mismatch');
      const destination=phase==='verify'?'artifacts':'staging-evidence';
      mkdirSync(destination,{recursive:true});
      // Re-extract only after source metadata and provenance have passed.
      extractArchive(join(dir,`${name+(source.legacy?`-${source.run.head_sha}`:'')}.zip`),destination,'zip');
    }
    assert(/^[a-f0-9]{40}$/.test(sha),'Invalid candidate commit');
    const build=await producer(buildRun,'build');
    assert.equal(build.run.head_sha,sha,'Build and evidence commit mismatch');
    execFileSync('git',['merge-base','--is-ancestor',sha,'origin/main'],{stdio:'pipe'});
    await download(build,`release-${sha}`,dir);
    extractArchive(join(dir,'release.tar.gz'),'.release','tar');
    validateArtifact('.release',sha);
    let owner=`run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT||'1'}`;
    if(phase==='verify'){
      owner=`run-${source.run.id}-${source.job.run_attempt||'1'}`;
      assert.equal(evidence.owner,owner,'Deployment lease owner differs from producer');
    }
    assert(/^run-[0-9]+-[0-9]+$/.test(owner),'Invalid release owner');
    const provenance={schema:1,sha,buildRun,sourceRun:Number(sourceNumber),phase};
    mkdirSync('artifacts',{recursive:true});
    writeFileSync('artifacts/workflow-source.json',JSON.stringify(provenance,null,2));
    appendFileSync(env.GITHUB_ENV,`CI_COMMIT_SHA=${sha}\nCI_RELEASE_ID=${owner}\n`);
    console.log(JSON.stringify(provenance));
  }finally{rmSync(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  await prepareWorkflow(process.argv[2],process.env.SOURCE_RUN);
}
