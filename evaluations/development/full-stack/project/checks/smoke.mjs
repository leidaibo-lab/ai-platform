import assert from 'node:assert/strict';

const api='http://api:3001';
const web='http://127.0.0.1:3000';
const evidence=[];
/** 每个HTTP断言保留真实响应；仅在固定容器内部运行。 */
function record(label,value) { evidence.push({label,...value}); }
/** 只等待本试点内部服务，60秒后失败。 */
async function ready(url) {
  for(let attempt=0;attempt<120;attempt++) {
    try { const response=await fetch(url,{signal:AbortSignal.timeout(1000)}); if(response.ok) return; } catch { /* 服务启动时有限重试。 */ }
    // 等待下一个固定轮询窗口。
    await new Promise((done)=>setTimeout(done,500));
  }
  throw new Error('内部服务就绪超时');
}
/** 验证创建、列表、非法输入和Next真实HTTP/代理；不推断浏览器交互通过。 */
async function initial() {
  const initialResponse=await fetch(api+'/api/tickets'); const initialBody=await initialResponse.json();
  record('initial-list',{status:initialResponse.status,body:initialBody}); assert.equal(initialResponse.status,200); assert.deepEqual(initialBody,[]);
  const created=await fetch(api+'/api/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'  合成工单  '})});
  const ticket=await created.json(); record('create',{status:created.status,body:ticket}); assert.equal(created.status,201);
  assert.match(ticket.id,/^[0-9a-f-]{36}$/i); assert.equal(ticket.title,'合成工单'); assert.ok(Number.isFinite(Date.parse(ticket.createdAt)));
  const invalid=[{},null,[],{title:''},{title:'  '},{title:2},{title:'x'.repeat(121)},{title:'ok',extra:true}];
  for(const body of invalid) {
    const response=await fetch(api+'/api/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    record('reject-invalid',{input:body,status:response.status,body:await response.text()}); assert.equal(response.status,400);
  }
  const listed=await (await fetch(api+'/api/tickets')).json(); record('list-after-invalid',{body:listed}); assert.equal(listed.length,1); assert.equal(listed[0].id,ticket.id);
  const secondResponse=await fetch(api+'/api/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'x'.repeat(120)})});
  const second=await secondResponse.json(); record('create-max-title',{status:secondResponse.status,body:second}); assert.equal(secondResponse.status,201); assert.equal(second.title.length,120);
  const finalListed=await (await fetch(api+'/api/tickets')).json();
  const expected=[ticket,second].sort(
    // 真实数据库必须遵守明确的时间与UUID倒序规则。
    (left,right)=>right.createdAt.localeCompare(left.createdAt)||right.id.localeCompare(left.id),
  );
  record('stable-order',{body:finalListed}); assert.deepEqual(finalListed,expected);
  const page=await fetch(web+'/'); const html=await page.text(); record('next-http',{status:page.status,containsHeading:html.includes('工单')}); assert.equal(page.status,200); assert.match(html,/工单/);
  const proxied=await fetch(web+'/api/tickets'); const proxyBody=await proxied.json(); record('next-proxy',{status:proxied.status,body:proxyBody}); assert.equal(proxied.status,200); assert.deepEqual(proxyBody,finalListed);
  return {tickets:[ticket,second],invalidInputs:invalid.length,apiCreateList:true,nextHttp:true,nextApiProxy:true,browserInteraction:'not-executed',evidence};
}
/** 按重启前的真实UUID与标题检查持久化，不重新创建数据。 */
async function persist(expected) {
  assert.ok(Array.isArray(expected)&&expected.length===2);
  const actual=await (await fetch(api+'/api/tickets')).json(); assert.equal(actual.length,expected.length);
  for(const item of expected) assert.ok(actual.some(
    // UUID和标题同时一致才算原记录恢复。
    (ticket)=>ticket.id===item.id&&ticket.title===item.title,
  ));
  return {restartPersistence:true,expected,actual};
}
/** 固定检查入口只支持initial和persist，拒绝任意URL或命令。 */
async function main() {
  await ready(api+'/api/tickets'); await ready(web+'/');
  const mode=process.argv[2];
  if(!['initial','persist'].includes(mode)) throw new Error('未知检查模式');
  console.log(JSON.stringify(mode==='initial'?await initial():await persist(JSON.parse(process.argv[3]))));
}
// 失败时保留已执行HTTP证据并返回非零，不把未执行项当通过。
main().catch((error)=>{console.error(JSON.stringify({failure:error.message,evidence}));process.exitCode=1;});
