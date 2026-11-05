import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeStore } from './store.js';
import { InputError, blank, hashPassword, verifyPassword, normalizeUsername, validUsername, validPassword, newToken, tokenHash, validateFinance } from './security.js';

const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
const allowSignup = String(process.env.ALLOW_SIGNUP || 'true').toLowerCase() === 'true';
const SESSION_DAYS = 30;
const maxBody = 2 * 1024 * 1024;
const attempts = new Map();
const listeners = new Map();
const html = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)));
// The content-security-policy script hash allows only the exact bundled inline JS.
const inline = html.toString().match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
const scriptHash = createHash('sha256').update(inline).digest('base64');
const CSP = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

const store = await makeStore();
store.onChange = ({userId,version}) => {
  const clients = listeners.get(userId);
  if (clients) for (const res of clients) {
    try { res.write(`event: version\ndata: ${JSON.stringify({version})}\n\n`); } catch {}
  }
};
function closeRevokedStreams(uid,keepSessionHash=null){
  for(const client of listeners.get(uid) || []){
    if(!keepSessionHash || client.finovaSessionHash !== keepSessionHash){
      try{client.end();}catch{}
    }
  }
}
const cleanAttempts = setInterval(() => {
  for (const [key,item] of attempts) if (item.until <= Date.now()) attempts.delete(key);
}, 60000).unref();
function throttle(key, limit, periodMs) {
  const now = Date.now(); let value = attempts.get(key);
  if (!value || value.until <= now) value = {count:0,until:now+periodMs};
  value.count++; attempts.set(key,value);
  return value.count <= limit;
}
const json = (res,status,payload,extra={}) => {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra });
  res.end(JSON.stringify(payload));
};
const fail = (status,message) => {const e = new Error(message); e.status = status; throw e;};
const parseCookie = (req) => {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)finova_session=([A-Za-z0-9_-]{16,150})(?:;|$)/);
  return match ? match[1] : null;
};
const cookie = (token, clear = false) => {
  const parts = [`finova_session=${clear?'':token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${clear?0:SESSION_DAYS*86400}`];
  if (production) parts.push('Secure');
  return parts.join('; ');
};
async function bodyJson(req) {
  const type = req.headers['content-type'] || '';
  if (!type.toLowerCase().startsWith('application/json')) fail(415,'JSON içerik türü gereklidir.');
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) fail(413,'İstek çok büyük (en fazla 2 MB).');
    chunks.push(chunk);
  }
  try { const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error(); return input; }
  catch { fail(400, 'Geçersiz JSON verisi.'); }
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const allowed = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : null;
    const incoming = new URL(origin);
    if (allowed) return incoming.origin === allowed;
    return incoming.host === req.headers.host && (incoming.protocol === 'https:' || (!production && incoming.protocol === 'http:'));
  } catch { return false; }
}
async function requireUser(req) {
  const token = parseCookie(req);
  if (!token) fail(401, 'Oturum açmanız gerekiyor.');
  const user = await store.findSession(tokenHash(token));
  if (!user) fail(401, 'Oturum sona ermiş, tekrar giriş yapın.');
  return {user,tokenHash:tokenHash(token)};
}
async function handle(req,res) {
  const route = new URL(req.url || '/', 'http://localhost').pathname;
  if (route === '/healthz' && req.method === 'GET') return json(res,200,{ok:true});
  if (route === '/' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(html);
  }
  if (route === '/favicon.ico' && req.method === 'GET') { res.writeHead(204);return res.end(); }
  if (!route.startsWith('/api/')) fail(404,'Sayfa bulunamadı.');
  if (!['GET','POST','PUT'].includes(req.method)) fail(405,'Bu yöntem desteklenmiyor.');
  if (req.method !== 'GET' && !originAllowed(req)) fail(403, 'Güvenlik doğrulaması başarısız (Origin).');
  if (route === '/api/auth/me' && req.method === 'GET') {
    const token = parseCookie(req);
    const user = token ? await store.findSession(tokenHash(token)) : null;
    return json(res,200,{user: user ? {id:user.id,username:user.username} : null, signupEnabled:allowSignup});
  }
  if (route === '/api/auth/register' && req.method === 'POST') {
    if (!allowSignup) fail(403,'Yeni hesap oluşturma kapalı.');
    const b = await bodyJson(req);
    const username = normalizeUsername(b.username);
    if (!validUsername(username)) fail(400,'Kullanıcı adı 3–32 karakter olmalı; küçük harf, rakam, nokta, tire ve alt çizgi kullanılabilir.');
    if (!validPassword(b.password)) fail(400,'Şifre 12–128 karakter olmalıdır.');
    if (!throttle('register:'+(req.socket.remoteAddress || '')+':'+username,5,3600000)) fail(429,'Çok fazla kayıt denemesi. Daha sonra deneyin.');
    const passHash = await hashPassword(b.password);
    let user;
    try { user = await store.createUser(username,passHash); }
    catch(e) { if (e.code === '23505') fail(409,'Bu kullanıcı adı kullanılıyor.'); throw e; }
    const token = newToken();
    await store.createSession(tokenHash(token),user.id,Date.now()+SESSION_DAYS*86400000);
    return json(res,201,{user:{id:user.id,username:user.username}},{'Set-Cookie':cookie(token)});
  }
  if (route === '/api/auth/login' && req.method === 'POST') {
    const b = await bodyJson(req);
    const username = normalizeUsername(b.username);
    if (!validUsername(username) || typeof b.password !== 'string' || b.password.length > 128) fail(401,'Kullanıcı adı veya şifre hatalı.');
    const clientKey = req.socket.remoteAddress || 'unknown';
    if (!throttle('login-ip:'+clientKey,60,15*60000) || !throttle('login-user:'+username,10,15*60000)) fail(429,'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.');
    const user = await store.findUser(username);
    // For nonexistent users, run scrypt too to avoid making usernames trivially enumerable.
    const fake = 'scrypt-n32768-r8-p3$1d03d73354d14aa33ce65bf32c73ea9c$'+ '00'.repeat(64);
    const success = await verifyPassword(b.password,user?.password_hash || fake);
    if (!user || !success) fail(401,'Kullanıcı adı veya şifre hatalı.');
    const token = newToken();
    await store.createSession(tokenHash(token),user.id,Date.now()+SESSION_DAYS*86400000);
    return json(res,200,{user:{id:user.id,username:user.username}},{'Set-Cookie':cookie(token)});
  }
  if (route === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookie(req);
    if (token){
      const digest=tokenHash(token);
      const exiting=await store.findSession(digest);
      await store.removeSession(digest);
      if(exiting){for(const stream of listeners.get(exiting.id)||[]){if(stream.finovaSessionHash===digest)stream.end();}}
    }
    return json(res,200,{ok:true},{'Set-Cookie':cookie('',true)});
  }
  const {user,tokenHash:sessionHash} = await requireUser(req);
  if (route === '/api/auth/change-password' && req.method === 'POST') {
    const b = await bodyJson(req);
    if (!validPassword(b.newPassword) || typeof b.oldPassword !== 'string') fail(400,'Yeni şifre 12–128 karakter olmalıdır.');
    const record = await store.findUser(user.username);
    if (!await verifyPassword(b.oldPassword,record.password_hash)) fail(403,'Mevcut şifre yanlış.');
    if (b.oldPassword === b.newPassword) fail(400,'Yeni şifreniz mevcut şifrenizden farklı olmalıdır.');
    await store.changePassword(user.id,await hashPassword(b.newPassword),sessionHash);
    closeRevokedStreams(user.id,sessionHash);
    return json(res,200,{ok:true});
  }
  if (route === '/api/finance' && req.method === 'GET') {
    const doc = await store.getFinance(user.id);
    if (!doc) fail(404,'Çalışma alanı bulunamadı.');
    return json(res,200,{data:doc.data, version:doc.version});
  }
  if (route === '/api/finance' && req.method === 'PUT') {
    const b = await bodyJson(req);
    if (!Number.isSafeInteger(b.version) || b.version < 0) fail(400,'Kayıt sürümü geçersiz.');
    const data = validateFinance(b.data);
    const version = await store.saveFinance(user.id,b.version,data);
    if (version === null) return json(res,409,{error:'version_conflict',message:'Veriler başka cihazda güncellenmiş. Üzerine yazılmadı.'});
    return json(res,200,{ok:true,version});
  }
  if (route === '/api/stream' && req.method === 'GET') {
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write(': connected\n\n');
    res.finovaSessionHash=sessionHash;
    const uid = user.id;
    if (!listeners.has(uid)) listeners.set(uid,new Set());
    listeners.get(uid).add(res);
    const keepalive = setInterval(() => {try {res.write(': heartbeat\n\n');}catch{}},20000);
    req.on('close',()=>{clearInterval(keepalive); listeners.get(uid)?.delete(res); if (!listeners.get(uid)?.size) listeners.delete(uid);});
    return;
  }
  fail(404,'API yolu bulunamadı.');
}
const server = http.createServer((req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',CSP);
  if (production) res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  handle(req,res).catch(error=>{
    const status = error instanceof InputError ? 400 : (error.status || 500);
    if (status === 500) console.error('API error:', error.message);
    if (!res.headersSent) json(res,status,{message:status===500?'Sunucu hatası. Daha sonra tekrar deneyin.':error.message});
    else res.end();
  });
});
server.listen(port,'0.0.0.0',()=>console.log(`Finova Cloud http://localhost:${port} (${production?'production':'development'})`));
async function shutdown() { clearInterval(cleanAttempts);server.close();await store.close(); }
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
