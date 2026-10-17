const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { sampleSegments, pipeline, checkSample } = require('../src/services/triage/stratified');
const segments = n => Array.from({length:n}, (_,i)=>({number:i+1,id:`p${i}@test`}));
test('30 percent without replacement covers every stratum even with shuffled NZB order',()=>{
  for(const n of [0,1,2,3,10,1022,2058,6719]) {
    const selected=sampleSegments(segments(n).reverse(),()=>.5), count=Math.ceil(n*.3);
    assert.equal(selected.length,count);assert.equal(new Set(selected.map(s=>s.id)).size,count);
    selected.forEach((s,i)=>{assert.ok(s.number-1>=Math.floor(i*n/count));assert.ok(s.number-1<Math.floor((i+1)*n/count));});
  }
});
test('duplicate IDs are not oversampled',()=>assert.equal(sampleSegments([...segments(10),...segments(10)]).length,3));
function socket(reply) {
  const s=new EventEmitter();s.commands=[];
  s.write=text=>{const ids=text.trim().split('\r\n').map(x=>x.slice(6,-1));s.commands.push(ids);setImmediate(()=>reply(s,ids));};
  return s;
}
test('pipeline handles fragmented replies and checks the entire selected sample',async()=>{
  const s=socket((sock,ids)=>{const text=ids.map(id=>`223 0 <${id}> exists\r\n`).join('');sock.emit('data',Buffer.from(text.slice(0,7)));sock.emit('data',Buffer.from(text.slice(7)));});
  const r=await pipeline(s,segments(150).map(x=>x.id),1000);
  assert.deepEqual(r,{planned:150,checked:150,missing:0});assert.deepEqual(s.commands.map(a=>a.length),[64,64,22]);
});
test('missing article drains batch then rejects early',async()=>{
 const s=socket((sock,ids)=>sock.emit('data',Buffer.from(ids.map((id,i)=>i===2?'430 missing\r\n':`223 0 <${id}> exists\r\n`).join(''))));
 assert.deepEqual(await pipeline(s,segments(100).map(x=>x.id),1000),{planned:100,checked:64,missing:1});assert.equal(s.commands.length,1);
});
test('unexpected status and mismatched identity cannot pass',async()=>{
 for(const line of ['500 unavailable\r\n','223 0 <other@test> exists\r\n']) {
  const s=socket(sock=>sock.emit('data',Buffer.from(line)));
  await assert.rejects(pipeline(s,['p0@test'],1000));
 }
});
test('silence times out and removes listeners',async()=>{
 const s=socket(()=>{});await assert.rejects(pipeline(s,['p0@test'],20));assert.equal(s.listenerCount('data'),0);
});
test('leased parser is always dropped, not reused',async()=>{
 const s=socket((sock,ids)=>sock.emit('data',Buffer.from(ids.map(id=>`223 0 <${id}> exists\r\n`).join(''))));
 s.destroy=()=>{s.destroyed=true;};const client={_socket:s,_queue:[]};let released;
 const pool={acquire:async()=>client,release:(c,opts)=>{assert.equal(c,client);released=opts;}};
 assert.equal((await checkSample(pool,segments(3))).checked,3);assert.equal(s.destroyed,true);assert.deepEqual(released,{drop:true});
});
