import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  configHome,
  globalConfigPath,
  projectConfigPath,
  readConfigFile,
  resolveConfig,
  writeConfig,
  type AgentBridgeConfigFile,
  type ConfigScope,
} from '@agentbridge/config';

interface UiOptions {
  projectPath?: string;
  projects?: string[];
}

const MAX_BODY_BYTES = 1_000_000;
const IDLE_CLOSE_MS = 15 * 60 * 1_000;

export async function startConfigUi(options: UiOptions = {}): Promise<void> {
  const token = randomBytes(24).toString('hex');
  const projects = uniqueProjects(options.projects ?? [], options.projectPath);
  let server: ReturnType<typeof createServer>;
  server = createServer((request, response) => {
    void handleRequest(request, response, server, token, projects, options.projectPath);
  });
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), IDLE_CLOSE_MS);
  };
  server.on('request', resetIdleTimer);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  resetIdleTimer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine the AgentBridge UI address');
  const initial = options.projectPath ? `&projectPath=${encodeURIComponent(options.projectPath)}` : '';
  const url = `http://127.0.0.1:${address.port}/?token=${token}${initial}`;
  if (process.env.AGENTBRIDGE_UI_NO_OPEN !== '1') openBrowser(url);
  console.error(`AgentBridge configuration UI: ${url}`);
  await new Promise<void>((resolvePromise) => server.once('close', resolvePromise));
  if (idleTimer) clearTimeout(idleTimer);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  server: ReturnType<typeof createServer>,
  token: string,
  projects: string[],
  initialProjectPath?: string,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/' && request.method === 'GET') {
      if (url.searchParams.get('token') !== token) return sendText(response, 403, 'Invalid AgentBridge UI token');
      return sendHtml(response, renderHtml(token, initialProjectPath));
    }
    if (!isAuthorized(request, token)) return sendJson(response, 403, { error: 'Invalid AgentBridge UI token' });
    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
      const projectPath = normalizeProjectPath(url.searchParams.get('projectPath'));
      return sendJson(response, 200, bootstrap(projectPath, projects));
    }
    if (url.pathname === '/api/config' && request.method === 'POST') {
      const body = await readJson(request);
      const scope = body.scope as ConfigScope;
      if (scope !== 'global' && scope !== 'project') throw new Error('scope must be global or project');
      const projectPath = scope === 'project' ? normalizeProjectPath(String(body.projectPath ?? '')) : undefined;
      if (scope === 'project' && !projectPath) throw new Error('A valid project path is required');
      const value = body.value as AgentBridgeConfigFile;
      const path = writeConfig(scope, value, projectPath ?? undefined);
      return sendJson(response, 200, { ok: true, path });
    }
    if (url.pathname === '/api/close' && request.method === 'POST') {
      sendJson(response, 200, { ok: true });
      setTimeout(() => server.close(), 50);
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function bootstrap(projectPath: string | null, projects: string[]): Record<string, unknown> {
  const globalPath = globalConfigPath();
  const projectPathValue = projectPath ? projectConfigPath(projectPath) : null;
  const effective = resolveConfig(projectPath);
  return {
    configHome: configHome(),
    globalPath,
    projectPath,
    projectConfigPath: projectPathValue,
    projects,
    global: existsSync(globalPath) ? readConfigFile(globalPath) : { version: 1 },
    project: projectPathValue && existsSync(projectPathValue) ? readConfigFile(projectPathValue) : { version: 1 },
    effective: {
      config: effective.config,
      sources: effective.sources,
    },
  };
}

function normalizeProjectPath(value: string | null): string | null {
  if (!value?.trim()) return null;
  const path = resolve(value);
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`Project directory does not exist: ${path}`);
  return path;
}

function uniqueProjects(values: string[], selected?: string): string[] {
  const candidates = [...values, ...(selected ? [selected] : [])];
  return [...new Set(candidates.map((value) => resolve(value)).filter((value) => existsSync(value)))].sort();
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers['x-agentbridge-token'];
  return header === token;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object');
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function renderHtml(token: string, initialProjectPath?: string): string {
  const safeToken = JSON.stringify(token).replace(/</g, '\\u003c');
  const safeProject = JSON.stringify(initialProjectPath ?? '').replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentBridge 配置</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f7fb;color:#172033;margin:0}
main{max-width:980px;margin:32px auto;padding:0 20px}.card{background:#fff;border:1px solid #dfe5ef;border-radius:14px;padding:22px;margin:16px 0;box-shadow:0 4px 16px #1720330b}
h1{margin:0 0 8px}h2{font-size:19px;margin:0 0 16px}h3{font-size:15px;margin:20px 0 8px;color:#526070}
label{display:flex;align-items:center;gap:12px;margin:12px 0;flex-wrap:wrap}.field{display:grid;grid-template-columns:240px 1fr;gap:12px;align-items:center;margin:12px 0}
input,select{font:inherit;border:1px solid #c7d0df;border-radius:8px;padding:8px;background:#fff}input[type=checkbox]{width:18px;height:18px}
button{font:inherit;border:0;border-radius:8px;padding:10px 16px;background:#2463eb;color:white;cursor:pointer;margin-right:8px}button.secondary{background:#e9eef8;color:#172033}
.muted{color:#657184;font-size:13px}.source{color:#64748b;font-size:12px;margin-left:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.disabled{opacity:.5;pointer-events:none}
pre{background:#101827;color:#d7e2f0;border-radius:8px;padding:14px;overflow:auto;font-size:12px}.status{min-height:22px;color:#166534;margin:10px 0}.error{color:#b42318}
@media(max-width:720px){.grid{grid-template-columns:1fr}.field{grid-template-columns:1fr}}
</style></head>
<body><main>
<h1>AgentBridge 配置</h1>
<p class="muted">配置只保存到 AgentBridge 的全局或当前项目文件；页面关闭后本地服务自动退出。</p>
<div class="card"><div class="field"><label for="project">当前项目</label><select id="project"></select></div><div id="paths" class="muted"></div></div>
<div class="grid"><section class="card"><h2>全局默认</h2><div id="globalForm"></div><button id="saveGlobal">保存全局配置</button></section>
<section class="card" id="projectCard"><h2>当前项目覆盖</h2><div id="projectForm"></div><button id="saveProject">保存项目配置</button></section></div>
<section class="card"><h2>最终生效配置</h2><div id="effective"></div><pre id="effectiveJson"></pre></section>
<div class="status" id="status"></div><button class="secondary" id="close">保存完成，关闭页面</button>
</main>
<script>
const token=${safeToken}; const initialProject=${safeProject}; let state=null;
const $=id=>document.getElementById(id);
const clone=v=>JSON.parse(JSON.stringify(v||{}));
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
const duration=v=>v==null?'unlimited':String(v);
const msDuration=ms=>ms===null?'无限制':(ms===undefined?'继承':(ms%86400000===0?ms/86400000+'天':ms%3600000===0?ms/3600000+'小时':ms%60000===0?ms/60000+'分钟':ms/1000+'秒'));
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'x-agentbridge-token':token,'content-type':'application/json',...(opts.headers||{})}});const v=await r.json();if(!r.ok)throw new Error(v.error||'请求失败');return v}
async function load(project){state=await api('/api/bootstrap'+(project?'?projectPath='+encodeURIComponent(project):''));render()}
function ensure(o,s){o[s]??={};return o[s]}
function input(label,key,value,checked,section){return '<div class="field"><label>'+label+'</label><span>'+ (key==='autonomous'?'<input type="checkbox" data-section="'+section+'" data-key="'+key+'" '+(checked?'checked':'')+'>' : '<input data-section="'+section+'" data-key="'+key+'" value="'+String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">') +'</span></div>'}
function renderForm(kind){const source=kind==='global'?state.global:state.project;const inv=source.invocation||{};const d=source.discussion||{};const isProject=kind==='project';const has=(k)=>own(inv,k)||own(d,k);const inherit=(k)=>isProject&&!has(k);let html='';
html+=isProject?'<p class="muted">勾选“继承全局”即可删除项目覆盖。</p>':'';
const auto=isProject? (inherit('autonomous')?'':String(inv.autonomous??true)) : String(inv.autonomous??true);
html+='<div class="field"><label>允许 AI 自主发起讨论</label><span><input type="checkbox" data-section="'+kind+'" data-key="autonomous" '+(auto==='true'?'checked':'')+' '+(inherit('autonomous')?'disabled':'')+'></span></div>';
if(isProject)html+='<label><input type="checkbox" data-inherit="autonomous" '+(inherit('autonomous')?'checked':'')+'> 继承全局自主调用设置</label>';
for(const [label,key] of [['最大讨论时间','maxDuration'],['静默超时','idleTimeout'],['单轮最大时间','turnHardLimit']]){const inh=inherit(key);html+='<div class="field"><label>'+label+'</label><span><input data-section="'+kind+'" data-key="'+key+'" value="'+duration(d[key]??'')+'" '+(inh?'disabled':'')+'></span></div>';if(isProject)html+='<label><input type="checkbox" data-inherit="'+key+'" '+(inh?'checked':'')+'> 继承全局 '+label+'</label>'}
const inh=inherit('maxTurns');html+='<div class="field"><label>最大讨论轮数</label><span><input type="number" min="1" max="50" data-section="'+kind+'" data-key="maxTurns" value="'+(d.maxTurns??'')+'" '+(inh?'disabled':'')+'></span></div>';if(isProject)html+='<label><input type="checkbox" data-inherit="maxTurns" '+(inh?'checked':'')+'> 继承全局最大轮数</label>';
return html}
function render(){const projects=state.projects||[];$('project').innerHTML='<option value="">仅配置全局</option>'+projects.map(p=>'<option value="'+p.replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">'+p.replace(/</g,'&lt;')+'</option>').join('');$('project').value=state.projectPath||'';$('paths').textContent='全局：'+state.globalPath+(state.projectConfigPath?' ｜ 项目：'+state.projectConfigPath:'');$('globalForm').innerHTML=renderForm('global');$('projectForm').innerHTML=renderForm('project');$('projectCard').classList.toggle('disabled',!state.projectPath);$('effectiveJson').textContent=JSON.stringify(state.effective.config,null,2);const rows=[];const c=state.effective.config;rows.push('<p>自主调用：<b>'+(c.invocation.autonomous?'允许':'关闭')+'</b><span class="source">来源：'+(state.effective.sources['invocation.autonomous']||'default')+'</span></p>');rows.push('<p>最大讨论时间：<b>'+msDuration(c.discussion.maxDurationMs)+'</b></p>');rows.push('<p>静默超时：<b>'+msDuration(c.discussion.idleTimeoutMs)+'</b></p>');rows.push('<p>单轮最大时间：<b>'+msDuration(c.discussion.turnHardLimitMs)+'</b></p>');rows.push('<p>最大讨论轮数：<b>'+(c.discussion.maxTurns??'按讨论模式')+'</b></p>');$('effective').innerHTML=rows.join('');bindFormEvents()}
function formValue(form,key){const el=form.querySelector('[data-key="'+key+'"]');if(!el)return undefined;return key==='autonomous'?el.checked:(key==='maxTurns'?(el.value?Number(el.value):undefined):el.value||undefined)}
function buildValue(kind){const source=clone(kind==='global'?state.global:state.project);source.version=1;const inv=ensure(source,'invocation'),d=ensure(source,'discussion');for(const key of ['autonomous']){const inheritEl=document.querySelector('[data-inherit="'+key+'"]');if(kind==='project'&&inheritEl?.checked)delete inv[key];else{const v=formValue(document.querySelector('#'+(kind==='global'?'globalForm':'projectForm')),key);if(v!==undefined)inv[key]=v}}
for(const key of ['maxDuration','idleTimeout','turnHardLimit','maxTurns']){const inheritEl=document.querySelector('[data-inherit="'+key+'"]');if(kind==='project'&&inheritEl?.checked)delete d[key];else{const v=formValue(document.querySelector('#'+(kind==='global'?'globalForm':'projectForm')),key);if(v!==undefined)d[key]=v}}
if(!Object.keys(inv).length)delete source.invocation;if(!Object.keys(d).length)delete source.discussion;return source}
function bindFormEvents(){document.querySelectorAll('[data-inherit]').forEach(el=>el.addEventListener('change',()=>render()));}
async function save(kind){try{const value=buildValue(kind);await api('/api/config',{method:'POST',body:JSON.stringify({scope:kind,projectPath:state.projectPath,value})});$('status').textContent='已保存 '+(kind==='global'?'全局':'项目')+' 配置';await load(state.projectPath)}catch(e){$('status').className='status error';$('status').textContent=e.message}}
$('project').addEventListener('change',e=>load(e.target.value));$('saveGlobal').addEventListener('click',()=>save('global'));$('saveProject').addEventListener('click',()=>save('project'));$('close').addEventListener('click',async()=>{await api('/api/close',{method:'POST'});window.close()});load(initialProject).catch(e=>{$('status').className='status error';$('status').textContent=e.message});
</script></body></html>`;
}
