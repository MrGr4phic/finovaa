import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function freePort(){
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));return port;
}
async function launch(){
  const port=await freePort(),origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server/index.js'],{cwd:new URL('../',import.meta.url),env:{...process.env,NODE_ENV:'test',FINOVA_TEST_MEMORY:'1',ALLOW_SIGNUP:'true',PORT:String(port),APP_ORIGIN:origin},stdio:'pipe'});
  let ready=false,err='';child.stdout.on('data',chunk=>{if(chunk.toString().includes('Finova Cloud'))ready=true;});child.stderr.on('data',x=>err+=x.toString());
  for(let i=0;i<80&&!ready;i++)await new Promise(r=>setTimeout(r,75));
  if(!ready){child.kill();throw Error('Server did not start: '+err);}
  return {origin,child};
}
const getCookie = (r) => r.headers.get('set-cookie')?.split(';')[0] || '';
const authHeaders = (origin,cookie) => ({'Content-Type':'application/json','Origin':origin,...(cookie?{Cookie:cookie}:{})});
const call = (origin,route,method='GET',cookie='',body=null) => fetch(origin+route,{
  method,headers:authHeaders(origin,cookie),...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)
});

test('registration, device sync, conflict prevention, user isolation and sessions', {timeout:60000}, async()=>{
  const {origin,child}=await launch();
  try {
    const a=await call(origin,'/api/auth/register','POST','',{username:'owner01',password:'PasswordOwner#2026'});
    assert.equal(a.status,201,await a.text());const cookie=getCookie(a);assert.match(cookie,/^finova_session=/);
    const me=await call(origin,'/api/auth/me','GET',cookie);assert.equal((await me.json()).user.username,'owner01');
    const finance=await call(origin,'/api/finance','GET',cookie);
    const {data,version}=await finance.json();assert.equal(version,0);assert.equal(data.accounts.length,0);
    const b=await call(origin,'/api/auth/login','POST','',{username:'owner01',password:'PasswordOwner#2026'});
    assert.equal(b.status,200);const otherDevice=getCookie(b);
    data.accounts.push({id:'bank_A',name:'Ana Kasa',bank:'Kasa',opening:2500});
    const save=await call(origin,'/api/finance','PUT',cookie,{version,data});
    assert.equal(save.status,200);assert.equal((await save.json()).version,1);
    const synced=await call(origin,'/api/finance','GET',otherDevice);const doc=await synced.json();
    assert.equal(doc.data.accounts[0].name,'Ana Kasa');
    const conflict=await call(origin,'/api/finance','PUT',otherDevice,{version:0,data});assert.equal(conflict.status,409);
    const bad=await call(origin,'/api/finance','PUT',cookie,{version:1,data:{...data,accounts:[]}});assert.equal(bad.status,200); // deleting an unreferenced account is valid
    const evil=await call(origin,'/api/auth/register','POST','',{username:'other01',password:'PasswordOther#2026'});assert.equal(evil.status,201);
    const second=getCookie(evil);const otherDoc=await call(origin,'/api/finance','GET',second);
    assert.equal((await otherDoc.json()).data.accounts.length,0);
    const forged=await fetch(origin+'/api/finance',{method:'PUT',headers:{'Content-Type':'application/json','Origin':'https://attacker.example','Cookie':cookie},body:JSON.stringify({version:2,data})});assert.equal(forged.status,403);
    const change=await call(origin,'/api/auth/change-password','POST',otherDevice,{oldPassword:'PasswordOwner#2026',newPassword:'UpdatedPassword#2026'});assert.equal(change.status,200);
    assert.equal((await call(origin,'/api/finance','GET',cookie)).status,401);
    assert.equal((await call(origin,'/api/finance','GET',otherDevice)).status,200);
    assert.equal((await call(origin,'/api/auth/logout','POST',otherDevice,{})).status,200);
    assert.equal((await call(origin,'/api/finance','GET',otherDevice)).status,401);
  } finally {child.kill('SIGTERM');}
});
