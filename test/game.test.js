const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const PORT = 34781;
let proc;
let sockets = [];
function sleep(ms) { return new Promise(res=>setTimeout(res,ms)); }
function makeClient() {
  return new Promise((resolve,reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const messages=[];
    const waiters=[];
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      messages.push(m);
      waiters.slice().forEach(w => { if (w.predicate(m)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w),1); w.resolve(m); } });
    });
    ws.addEventListener('error', e => reject(e));
    ws.addEventListener('open',()=>resolve({
      raw: ws,
      send: m => ws.send(JSON.stringify(m)),
      wait: (predicate, timeout=2500) => {
        const existing=messages.find(predicate); if(existing) { messages.splice(messages.indexOf(existing),1); return Promise.resolve(existing); }
        return new Promise((resolve,reject)=>{const w={predicate,resolve,reject,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(w),1);reject(Error('Timed out waiting for state'))},timeout)};waiters.push(w)});
      },
      clear:()=>{messages.length=0},
      close:()=>ws.close()
    }));
    sockets.push(ws);
  });
}
const id1='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', id2='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
before(async()=>{
  proc=spawn(process.execPath,['server.js'],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,PORT:String(PORT),TURN_REVEAL_MS:'30',STAGE_REVEAL_MS:'45'}});
  let ready=false;
  for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/health`);if(r.ok){ready=true;break}}catch{} await sleep(20)}
  assert.ok(ready,'server launched');
});
after(()=>{sockets.forEach(s=>s.close());proc?.kill()});
test('HTML and CSS are served',async()=>{
  const home=await fetch(`http://127.0.0.1:${PORT}/`), css=await fetch(`http://127.0.0.1:${PORT}/style.css`);
  assert.equal(home.status,200);assert.match(await home.text(),/胆小鬼俱乐部/);
  assert.equal(css.status,200);
});
test('two devices can create room, exchange secret decisions, finish 5 stages and rematch',async()=>{
  const a=await makeClient(),b=await makeClient();
  a.send({type:'create',playerId:id1,name:'橘子'});
  const joined=await a.wait(m=>m.type==='joined');
  assert.match(joined.code,/^[A-HJ-NP-Z2-9]{6}$/);
  b.send({type:'join',playerId:id2,name:'桃子',code:joined.code});
  const seat=await b.wait(m=>m.type==='state'&&m.room.players.length===2);
  assert.deepEqual(seat.room.players.map(p=>p.name),['橘子','桃子']);
  a.send({type:'start'});
  const stage=await a.wait(m=>m.type==='state'&&m.room.status==='playing'&&m.room.stage===1);
  assert.equal(stage.room.players[0].score,0);
  // One secret vote should be visible only as a committed flag; not as its value.
  a.clear();b.clear();
  a.send({type:'choose',choice:3});
  const secret=await b.wait(m=>m.type==='state'&&m.room.players[0].committed);
  assert.equal(secret.room.lastReveal,null);
  assert.equal('choice' in secret.room.players[0],false);
  b.send({type:'choose',choice:1});
  const reveal=await a.wait(m=>m.type==='state'&&m.room.phase==='reveal');
  assert.equal(reveal.room.lastReveal.actions.length,2);
  assert.ok(reveal.room.lastReveal.actions.every(x=>x.outcome==='safe'));
  await a.wait(m=>m.type==='state'&&m.room.phase==='choose'&&m.room.stage===1&&m.room.players[0].position===3);
  // Both bank their step points, then go through the remaining four stages.
  a.clear();b.clear();a.send({type:'choose',choice:'bank'});b.send({type:'choose',choice:'bank'});
  await a.wait(m=>m.type==='state'&&m.room.phase==='reveal'&&m.room.lastReveal?.stageEnd);
  for(let s=2;s<=5;s++){
    await a.wait(m=>m.type==='state'&&m.room.stage===s&&m.room.phase==='choose');
    a.clear();b.clear();a.send({type:'choose',choice:1});b.send({type:'choose',choice:2});
    await a.wait(m=>m.type==='state'&&m.room.stage===s&&m.room.phase==='reveal');
    await a.wait(m=>m.type==='state'&&m.room.stage===s&&m.room.phase==='choose'&&m.room.players[0].position===1);
    a.clear();b.clear();a.send({type:'choose',choice:'bank'});b.send({type:'choose',choice:'bank'});
    await a.wait(m=>m.type==='state'&&m.room.stage===s&&m.room.phase==='reveal'&&m.room.lastReveal?.stageEnd);
  }
  const finish=await a.wait(m=>m.type==='state'&&m.room.status==='finished');
  assert.equal(finish.room.players[0].score,70); // 30 + 10*4
  assert.equal(finish.room.players[1].score,90); // 10 + 20*4
  assert.equal(finish.room.winner,id2);
  a.send({type:'rematch'});
  const waiting=await a.wait(m=>m.type==='state'&&m.room.players[0].rematchReady);
  assert.equal(waiting.room.status,'finished');
  b.send({type:'rematch'});
  const rematch=await a.wait(m=>m.type==='state'&&m.room.status==='playing'&&m.room.stage===1&&m.room.players[1].score===0);
  assert.equal(rematch.room.players[0].rematchReady,false);
  a.close();b.close();
});
test('reject invalid room and preserve seat after reconnect',async()=>{
  const a=await makeClient();
  a.send({type:'join',playerId:'cccccccc-cccc-4ccc-cccc-cccccccccccc',name:'A',code:'NOTFUN'});
  const error=await a.wait(m=>m.type==='error');
  assert.match(error.message,/找不到/);
  a.send({type:'create',playerId:id1,name:'A'});
  const {code}=await a.wait(m=>m.type==='joined');
  a.close();await sleep(40);
  const b=await makeClient();
  b.send({type:'join',playerId:id1,name:'A',code});
  const rejoin=await b.wait(m=>m.type==='state'&&m.room.code===code);
  assert.equal(rejoin.room.players.length,1);
  assert.equal(rejoin.room.players[0].connected,true);
  b.close();
});
test('falling loses only current stage pot; a banked player never has to choose again',async()=>{
  const a=await makeClient(), b=await makeClient();
  a.send({type:'create',playerId:'dddddddd-dddd-4ddd-dddd-dddddddddddd',name:'胆大'});
  const {code}=await a.wait(m=>m.type==='joined');
  b.send({type:'join',playerId:'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',name:'胆小',code});
  await b.wait(m=>m.type==='state'&&m.room.players.length===2);
  a.send({type:'start'});
  await a.wait(m=>m.type==='state'&&m.room.status==='playing');
  a.clear();b.clear();
  a.send({type:'choose',choice:3});b.send({type:'choose',choice:3});
  await a.wait(m=>m.type==='state'&&m.room.phase==='reveal');
  await a.wait(m=>m.type==='state'&&m.room.phase==='choose'&&m.room.players[0].position===3);
  a.clear();b.clear();
  a.send({type:'choose',choice:3});b.send({type:'choose',choice:'bank'});
  let reveal=await a.wait(m=>m.type==='state'&&m.room.phase==='reveal'&&m.room.lastReveal?.actions.some(x=>x.choice==='bank'));
  if (!reveal.room.lastReveal.stageEnd) {
    await a.wait(m=>m.type==='state'&&m.room.phase==='choose');
    a.clear();b.clear();
    a.send({type:'choose',choice:3});
    reveal=await a.wait(m=>m.type==='state'&&m.room.phase==='reveal'&&m.room.lastReveal?.stageEnd);
  }
  assert.equal(reveal.room.players[0].status,'fallen');
  assert.equal(reveal.room.players[0].score,0);
  assert.equal(reveal.room.players[1].status,'banked');
  assert.equal(reveal.room.players[1].score,30);
  assert.ok(reveal.room.lastReveal.limit>=5 && reveal.room.lastReveal.limit<=9);
  a.close();b.close();
});
