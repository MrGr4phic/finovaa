import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];

function run({authenticated}){
  const elements=new Map(), events=new Map();
  const get=(id)=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',className:'',focus(){},reset(){},style:{}});return elements.get(id)};
  const fakeFetch=async(path,opts)=>({ok:true,status:200,json:async()=>path==='/api/auth/me'?{user:authenticated?{id:'u1',username:'owner'}:null,signupEnabled:true}:
    path==='/api/finance'?{version:0,data:{demo:false,accounts:[],contacts:[],transactions:[],obligations:[]}}:{ok:true}});
  const context={document:{title:'',getElementById:get,addEventListener:(event,handler)=>{if(!events.has(event))events.set(event,[]);events.get(event).push(handler)}},window:{scrollTo(){},addEventListener(){}},
    fetch:fakeFetch,EventSource:class{addEventListener(){}close(){}},setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{},
    console,Date,Intl,URL,structuredClone,confirm:()=>true,Math};
  vm.runInNewContext(code,context,{timeout:5000});
  return {get,events,context};
}
const settle=()=>new Promise(r=>setTimeout(r,20));
test('authenticated frontend renders every finance module without runtime error',async()=>{
  const app=run({authenticated:true});await settle();
  assert.match(app.get('app').innerHTML,/Finansal durumunuz tek ekranda/);
  for(const [section,needle] of [['accounts','Banka & Kasa Hesapları'],['contacts','Cari Hesaplar'],['transactions','Gelir & Gider'],['obligations','Ödeme'],['reports','Rapor'],['settings','Hesap Güvenliği']]){
    const el={dataset:{page:section}};
    const target={closest(sel){return sel==='[data-page]'?el:null;}};
    for(const cb of app.events.get('click')) cb({target});
    assert.match(app.get('app').innerHTML,new RegExp(needle),section);
  }
});
test('unauthenticated user sees a login form without financial records',async()=>{
  const app=run({authenticated:false});await settle();
  assert.match(app.get('app').innerHTML,/Kullanıcı adı/);
  assert.match(app.get('app').innerHTML,/Giriş Yap/);
  assert.doesNotMatch(app.get('app').innerHTML,/Son İşlemler/);
});
