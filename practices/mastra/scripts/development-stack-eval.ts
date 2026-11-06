/**
 * 独立Ticket全栈研发PoC：主持参考实现与真实Agent实现分别登记。
 * ADR: evaluations/development/full-stack/decision.md
 * 固定Docker命令仅属于此组织者入口，不扩展Agent执行工具。
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFileSync,copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {DevelopmentExecution} from '../src/development-execution.js';
import {generateDevelopment,parseDevelopmentJson} from '../src/development/agents.js';
import {architectureSchema,developmentHash,validateArchitecture,type DevelopmentState} from '../src/development/contracts.js';
import {readConfig} from '../src/mastra/config.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const assets=resolve(root,'evaluations/development/full-stack');

/** 只复制普通项目文件，不复制宿主安装产物、链接、环境或运行日志。 */
function copyProject(source:string,target:string):void {
  mkdirSync(target,{recursive:true,mode:0o700});
  for(const entry of readdirSync(source,{withFileTypes:true})) {
    if(['node_modules','dist','generated','.next','.env'].includes(entry.name)||entry.name.startsWith('.env.')) continue;
    if(entry.isSymbolicLink()) throw new Error('试点输入含符号链接');
    const next=resolve(target,entry.name);
    if(entry.isDirectory()) copyProject(resolve(source,entry.name),next);
    else if(entry.isFile()) copyFileSync(resolve(source,entry.name),next);
  }
}

/** 保存纯JSON证据；调用方只传脱敏配置和实际结果。 */
function save(path:string,value:unknown):void { writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600}); }

/** 含隐藏固定配置的完整源码树散列，不读取node_modules或环境文件。 */
function treeHashes(directory:string,prefix=''):Record<string,string> {
  const result:Record<string,string>={};
  for(const entry of readdirSync(directory,{withFileTypes:true})) {
    if(['node_modules','dist','generated','.next'].includes(entry.name)) continue;
    if(entry.isSymbolicLink()) throw new Error('候选含符号链接');
    const key=prefix+entry.name;
    if(entry.isDirectory()) Object.assign(result,treeHashes(resolve(directory,entry.name),key+'/'));
    else result[key]=createHash('sha256').update(readFileSync(resolve(directory,entry.name))).digest('hex');
  }
  return result;
}

/** CLI严格限制新输出目录；reference与agent永不覆盖同一批次。 */
async function main():Promise<void> {
  const {values}=parseArgs({options:{source:{type:'string',default:'reference'},live:{type:'boolean',default:false},out:{type:'string'}}});
  if(!['reference','agent'].includes(values.source!)) throw new Error('source仅支持reference或agent');
  if(values.source==='agent'&&!values.live) throw new Error('agent来源必须显式--live');
  const directory=resolve(root,values.out??`.data/evaluations/development-stack-${values.source}-${Date.now()}`);
  const child=relative(resolve(root,'.data/evaluations'),directory);
  if(!child||child.startsWith('..')||child.startsWith('/')) throw new Error('输出目录越界');
  mkdirSync(dirname(directory),{recursive:true}); mkdirSync(directory,{mode:0o700});
  const candidate=resolve(directory,'candidate'); copyProject(resolve(assets,'project'),candidate);
  const input=JSON.parse(readFileSync(resolve(assets,'input.json'),'utf8')) as {requirement:string;writablePaths:string[];publicChecks:string[]};
  const baseline=treeHashes(candidate);
  const tag=`mastra-ticket-pilot:${Date.now()}`;
  const project=`mastra-ticket-${Date.now()}`;
  const compose=['compose','--project-name',project,'--file',resolve(assets,'compose.yaml')];
  const commands:unknown[]=[];
  const report:Record<string,unknown>={source:values.source==='agent'?'live-agent-with-host-scaffold':'host-reference',capabilityAdmission:null,humanScore:null,browserInteraction:'not-executed',outcome:'running',cleanup:false};
  save(resolve(directory,'manifest.json'),{version:'ticket-stack-pilot.v1',createdAt:new Date().toISOString(),source:report.source,inputHash:developmentHash(input),hostScaffold:baseline,toolingHashes:{dockerfile:developmentHash(readFileSync(resolve(assets,'Dockerfile'),'utf8')),compose:developmentHash(readFileSync(resolve(assets,'compose.yaml'),'utf8')),runner:developmentHash(readFileSync(fileURLToPath(import.meta.url),'utf8'))},dockerContext:'colima',project,image:tag,node:process.version,nonGoals:['独立测试阶段','生产部署','多案例能力准入','人工评分']});
  /** 只有组织者可调用固定Docker argv；不传递模型凭据，不挂载宿主目录。 */
  async function docker(label:string,args:string[],timeout=600000):Promise<string> {
    const path=resolve(directory,label+'.log');
    const started=Date.now(); let output=''; let code:number|null=null;
    try {
      // 子进程只执行当前组织者固定的Docker命令。
      output=await new Promise<string>((done,fail)=>{
        const processHandle=spawn('docker',['--context','colima',...args],{env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:process.env.DOCKER_CONFIG,TMPDIR:process.env.TMPDIR,STACK_IMAGE:tag},stdio:['ignore','pipe','pipe'],timeout});
        let captured='';
        /** 固定构建日志有上限，超限直接终止并判失败。 */
        function record(chunk:Buffer):void { const text=chunk.toString(); appendFileSync(path,text,{mode:0o600}); captured+=text; if(Buffer.byteLength(captured)>4000000) processHandle.kill('SIGKILL'); }
        processHandle.stdout.on('data',record); processHandle.stderr.on('data',record);
        // 启动错误只作为固定失败，不向终端输出宿主环境。
        processHandle.once('error',()=>fail(new Error('Docker命令启动失败')));
        // 真实退出码进入证据；失败保留日志供审阅。
        processHandle.once('close',(exit)=>{code=exit; if(exit===0) done(captured); else fail(new Error(label+'失败'));});
      });
      return output;
    } finally { commands.push({label,argv:['docker','--context','colima',...args],exitCode:code,elapsedMs:Date.now()-started}); save(resolve(directory,'commands.json'),commands); }
  }
  try {
    report.phase='generation';
    if(values.source==='reference') {
      for(const path of input.writablePaths) copyFileSync(resolve(assets,'reference',path.split('/').at(-1)!),resolve(candidate,path));
    } else {
      process.env.MASTRA_MODE='live'; process.env.MASTRA_DATA_DIR=resolve(directory,'configuration');
      const config=readConfig();
      const execution=new DevelopmentExecution(candidate,input.writablePaths,[]);
      try {
        const files:Record<string,string>={};
        for(const path of ['package.json','api/database.ts','api/main.ts','prisma/schema.prisma',...input.writablePaths]) files[path]=readFileSync(resolve(candidate,path),'utf8');
        let state:DevelopmentState={input:{source:{kind:'evaluation',runId:project,hash:developmentHash(input.requirement),content:input.requirement,evidence:'evaluation-input'},project:{id:'ticket-stack',files,writablePaths:input.writablePaths,checkFiles:[],roles:['backend','frontend']},maxReworks:0},mode:'live',plan:null,planHash:null,planSourceHash:null,approvedHash:null,reviews:[],round:0,route:'all',work:[],checks:[],history:[],outcome:'in-progress',delivery:null,checkpointHash:null,completedTasks:[],faults:[],recovery:null,recoveries:[]};
        const architecture=await generateDevelopment(config,'architect',execution,state);
        const plan=architectureSchema.parse(parseDevelopmentJson(architecture.text)); validateArchitecture(plan,state.input);
        state={...state,plan,planHash:developmentHash(plan),work:[architecture]};
        save(resolve(directory,'architecture.json'),{authority:'evaluation-policy',humanApproval:false,state});
        if(plan.blockers.length) throw new Error('架构方案保留阻塞，未启动实现');
        for(const task of plan.tasks) {
          const entry=await generateDevelopment(config,task.role,execution,state,task.paths,task);
          state={...state,work:[...state.work,entry]}; save(resolve(directory,'agent-work.json'),state.work);
          if(entry.text.includes('ARCHITECTURE_BLOCKER:')) throw new Error('实现报告架构阻塞');
        }
        report.modelCalls=state.work.map(
          // 只暴露实际模型标识、用量和原生工具事实，不保存provider配置。
          (entry)=>({role:entry.role,modelId:entry.modelId,inputTokens:entry.inputTokens,outputTokens:entry.outputTokens,tools:entry.tools}),
        );
      } finally { await execution.close(); }
    }
    const sources=treeHashes(candidate); save(resolve(directory,'candidate-hashes.json'),sources);
    for(const [path,hash] of Object.entries(baseline)) if(!input.writablePaths.includes(path)) assert.equal(sources[path],hash,'固定装配文件被修改：'+path);
    report.sourceHash=developmentHash(sources);
    report.phase='build'; await docker('build',['build','--progress=plain','--tag',tag,'--file',resolve(assets,'Dockerfile'),candidate]);
    report.phase='migration'; await docker('database',[...compose,'up','--detach','--wait','db']);
    await docker('images',['image','inspect',tag,'node:24.19.0-bookworm-slim','postgres:17-bookworm','--format','{{json .RepoDigests}} {{.Id}} {{.Architecture}}']);
    await docker('migration',[...compose,'run','--rm','--no-deps','api','npm','run','migrate:deploy']);
    await docker('services',[...compose,'up','--detach','api','web']);
    report.phase='public-smoke';
    const result=JSON.parse((await docker('http-smoke',[...compose,'exec','--no-TTY','web','node','checks/smoke.mjs','initial'])).trim()) as {tickets:{id:string;title:string}[]};
    save(resolve(directory,'smoke.json'),result);
    report.phase='restart-persistence';
    await docker('restart-db',[...compose,'restart','db']); await docker('db-ready',[...compose,'up','--detach','--wait','db']);
    await docker('restart-api-web',[...compose,'restart','api','web']);
    const persisted=JSON.parse((await docker('persistence',[...compose,'exec','--no-TTY','web','node','checks/smoke.mjs','persist',JSON.stringify(result.tickets)])).trim());
    save(resolve(directory,'persistence.json'),persisted);
    report.outcome='public-smoke-passed'; report.phase='complete'; report.checks={...result,migration:true,restartPersistence:true};
  } catch(error) { report.outcome='failed'; report.failure=error instanceof Error&&(error.name==='AssertionError'||/^[a-zA-Z-]+失败$/.test(error.message))?error.message:'试点生成、构建或公开断言未完成'; }
  finally {
    try { await docker('container-logs',[...compose,'logs','--no-color'],30000); } catch { /* 启动前失败时仍继续清理。 */ }
    try { await docker('cleanup',[...compose,'down','--volumes','--remove-orphans'],60000); report.cleanup=true; } catch { report.cleanup=false; }
    if(existsSync(resolve(directory,'build.log'))) { try { await docker('image-cleanup',['image','rm',tag],30000); } catch { /* 无镜像的构建失败无需额外删除。 */ } }
    save(resolve(directory,'report.json'),report); console.log(JSON.stringify({directory,...report},null,2));
  }
  if(report.outcome!=='public-smoke-passed'||!report.cleanup) process.exitCode=1;
}
// 所有原始Docker事实保存在忽略目录；终端不输出provider错误或凭据。
main().catch(()=>{console.error('全栈试点未完成；请检查本次目录中的脱敏报告。');process.exitCode=1;});
