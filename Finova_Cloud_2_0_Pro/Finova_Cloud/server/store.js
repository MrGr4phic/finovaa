import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { blank } from './security.js';

export class MemoryStore { // For automated tests only; never used in production.
  constructor() { this.users = new Map(); this.sessions = new Map(); this.documents = new Map(); this.onChange = null; }
  async init() {}
  async findUser(username) { return this.users.get(username) || null; }
  async createUser(username, passwordHash) {
    if (this.users.has(username)) { const error = Error('duplicate'); error.code = '23505'; throw error; }
    const user = { id: randomUUID(), username, password_hash: passwordHash };
    this.users.set(username, user);
    this.documents.set(user.id, { data: blank(), version: 0 });
    return user;
  }
  async createSession(token, uid, expiry) { this.sessions.set(token, {userId:uid, expiry}); }
  async findSession(token) {
    const session = this.sessions.get(token);
    if (!session || session.expiry <= Date.now()) return null;
    const user = [...this.users.values()].find(u=>u.id===session.userId);
    return user ? { id:user.id, username:user.username } : null;
  }
  async removeSession(token) { this.sessions.delete(token); }
  async changePassword(uid, password, currentToken) {
    const user = [...this.users.values()].find(u=>u.id===uid);
    if (user) user.password_hash = password;
    for (const [key,s] of this.sessions.entries()) if (s.userId === uid && key !== currentToken) this.sessions.delete(key);
  }
  async getFinance(uid) { return structuredClone(this.documents.get(uid)); }
  async saveFinance(uid, expected, data) {
    const doc = this.documents.get(uid);
    if (!doc || doc.version !== expected) return null;
    doc.data = structuredClone(data); doc.version++;
    this.onChange?.({userId:uid,version:doc.version});
    return doc.version;
  }
  async close() {}
}

export class PostgresStore {
  constructor(url) { this.url = url; this.pool = null; this.listener = null; this.onChange = null; }
  async init() {
    const { Pool, Client } = await import('pg');
    this.PgClient = Client;
    this.pool = new Pool({ connectionString: this.url, max: 10, idleTimeoutMillis: 15000, connectionTimeoutMillis: 10000 });
    this.pool.on('error', err => console.error('PostgreSQL pool error:', err.message));
    // The schema is idempotent. Do not delete or reset production data at startup.
    const sql = await readFile(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');
    await this.pool.query(sql);
    this.connectListener();
  }
  async connectListener() {
    if (this.listener || this.stopped) return;
    try {
      const client = new this.PgClient({connectionString:this.url});
      client.on('notification', n => {
        if (n.channel !== 'finova_updates') return;
        try { const info = JSON.parse(n.payload); this.onChange?.(info); } catch {}
      });
      client.on('error', e => { console.error('Sync listener:', e.message); this.disconnectListener(client); });
      client.on('end', () => this.disconnectListener(client));
      await client.connect();
      await client.query('LISTEN finova_updates');
      this.listener = client;
    } catch (e) {
      console.error('Realtime listener unavailable; clients will poll:', e.message);
      this.listener = null;
      if (!this.stopped) this.scheduleReconnect();
    }
  }
  disconnectListener(client) {
    if (this.listener === client) this.listener = null;
    if (!this.stopped) this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {this.reconnectTimer=null; this.connectListener();}, 10000);
  }
  async findUser(username) {
    const {rows} = await this.pool.query('SELECT id,username,password_hash FROM users WHERE username=$1', [username]);
    return rows[0] || null;
  }
  async createUser(username, passwordHash) {
    const client = await this.pool.connect(), user = { id:randomUUID(), username, password_hash:passwordHash };
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users (id, username, password_hash) VALUES ($1,$2,$3)',[user.id,username,passwordHash]);
      await client.query('INSERT INTO finance_documents (user_id, data) VALUES ($1,$2::jsonb)',[user.id,JSON.stringify(blank())]);
      await client.query('COMMIT');
      return user;
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async createSession(token, uid, expiry) {
    await this.pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,to_timestamp($3 / 1000.0))',[token,uid,expiry]);
  }
  async findSession(token) {
    const {rows} = await this.pool.query('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()',[token]);
    return rows[0] || null;
  }
  async removeSession(token) { await this.pool.query('DELETE FROM sessions WHERE token_hash=$1',[token]); }
  async changePassword(uid, hash, currentToken) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,uid]);
      await client.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2',[uid,currentToken]);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async getFinance(uid) {
    const {rows} = await this.pool.query('SELECT data,version FROM finance_documents WHERE user_id=$1',[uid]);
    if (!rows.length) return null;
    return {data:rows[0].data, version:Number(rows[0].version)};
  }
  async saveFinance(uid, expected, data) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const {rows} = await client.query(`UPDATE finance_documents
        SET data=$3::jsonb, version=version+1, updated_at=now()
        WHERE user_id=$1 AND version=$2 RETURNING version`, [uid,expected,JSON.stringify(data)]);
      if (!rows.length) { await client.query('ROLLBACK'); return null; }
      const next = Number(rows[0].version);
      await client.query("SELECT pg_notify('finova_updates', $1)",[JSON.stringify({userId:uid,version:next})]);
      await client.query('COMMIT');
      return next;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.listener) await this.listener.end().catch(()=>{});
    if (this.pool) await this.pool.end();
  }
}
export async function makeStore() {
  if (process.env.NODE_ENV === 'test' && process.env.FINOVA_TEST_MEMORY === '1') {
    const memory = new MemoryStore(); await memory.init(); return memory;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL eksik. PostgreSQL bağlantısını yapılandırın.');
  const db = new PostgresStore(process.env.DATABASE_URL);
  await db.init(); return db;
}
