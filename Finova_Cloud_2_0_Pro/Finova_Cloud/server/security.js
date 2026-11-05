import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
// OWASP-equivalent scrypt settings: N = 2^15, r = 8, p = 3 (~32 MiB per operation).
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const blank = () => ({ demo: false, accounts: [], contacts: [], transactions: [], obligations: [] });
export const normalizeUsername = (value) => String(value || '').trim().toLowerCase();
export const validUsername = (value) => /^[a-z0-9._-]{3,32}$/.test(value);
export const validPassword = (value) => typeof value === 'string' && value.length >= 12 && value.length <= 128;
export const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64, OPTIONS);
  return `scrypt-n32768-r8-p3$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt-n32768-r8-p3$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  const hash = await scrypt(password, Buffer.from(parts[1], 'hex'), 64, OPTIONS);
  return timingSafeEqual(hash, Buffer.from(parts[2], 'hex'));
}
export class InputError extends Error { constructor(message) { super(message); this.status = 400; } }
const text = (value, label, max = 140, min = 0) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw new InputError(`${label} geçersiz (en fazla ${max} karakter).`);
  return value.trim();
};
const optional = (value, label, max = 140) => value == null || value === '' ? null : text(value, label, max);
const money = (value, label, allowNegative = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 999999999999 || (!allowNegative && value <= 0))
    throw new InputError(`${label} geçerli bir tutar olmalıdır.`);
  if (Math.abs(value * 100 - Math.round(value * 100)) > .0001) throw new InputError(`${label} en fazla iki ondalıklı olabilir.`);
  return value;
};
const date = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
    throw new InputError(`${label} tarihi geçersiz.`);
  return value;
};
const id = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new InputError('Kayıt kimliği geçersiz.');
  return value;
};
const checkUnique = (items, label) => {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new InputError(`${label} içinde yinelenen kayıt mevcut.`);
    seen.add(item.id);
  }
};
const permitted = (value, choices, label) => {
  if (!choices.includes(value)) throw new InputError(`${label} geçersiz.`);
  return value;
};
export function validateFinance(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Finans verileri geçersiz.');
  for (const kind of ['accounts', 'contacts', 'transactions', 'obligations']) {
    if (!Array.isArray(input[kind]) || input[kind].length > 12000) throw new InputError(`${kind} kayıtları geçersiz veya fazla.`);
  }
  const accounts = input.accounts.map(a => ({
    id: id(a?.id), name: text(a.name, 'Hesap adı', 80, 1), bank: text(a.bank, 'Banka adı', 80, 1),
    opening: money(a.opening, 'Başlangıç bakiyesi', true)
  }));
  const contacts = input.contacts.map(c => ({
    id: id(c?.id), name: text(c.name, 'Cari adı', 130, 1),
    type: permitted(c.type, ['customer', 'supplier', 'both'], 'Cari türü'),
    phone: optional(c.phone, 'Telefon', 30) || '', email: optional(c.email, 'E-posta', 130) || ''
  }));
  const obligations = input.obligations.map(o => ({
    id: id(o?.id), type: permitted(o.type, ['receivable', 'payable'], 'Vade türü'),
    contactId: id(o.contactId), amount: money(o.amount, 'Planlanan tutar'),
    dueDate: date(o.dueDate, 'Vade'), description: text(o.description, 'Plan açıklaması', 250, 1)
  }));
  const transactions = input.transactions.map(t => ({
    id: id(t?.id), type: permitted(t.type, ['income', 'expense', 'transfer'], 'İşlem türü'),
    amount: money(t.amount, 'İşlem tutarı'), date: date(t.date, 'İşlem'),
    description: text(t.description, 'İşlem açıklaması', 250, 1), category: text(t.category || 'Diğer', 'Kategori', 100, 1),
    accountId: id(t.accountId), toAccountId: t.toAccountId ? id(t.toAccountId) : null,
    contactId: t.contactId ? id(t.contactId) : null,
    obligationId: t.obligationId ? id(t.obligationId) : null
  }));
  for (const [rows, label] of [[accounts, 'Hesaplar'], [contacts, 'Cariler'], [obligations, 'Vadeler'], [transactions, 'İşlemler']]) checkUnique(rows, label);
  const aid = new Set(accounts.map(a => a.id)), cid = new Set(contacts.map(c => c.id));
  const obs = new Map(obligations.map(o => [o.id, o]));
  for (const o of obligations) if (!cid.has(o.contactId)) throw new InputError('Bir vadenin cari hesabı bulunamadı.');
  const paid = new Map();
  for (const t of transactions) {
    if (!aid.has(t.accountId)) throw new InputError('Bir işlemin banka/kasa hesabı bulunamadı.');
    if (t.type === 'transfer' && (!t.toAccountId || !aid.has(t.toAccountId) || t.toAccountId === t.accountId)) throw new InputError('Transferin hedef hesabı geçersiz.');
    if (t.type !== 'transfer' && t.toAccountId) throw new InputError('Hedef hesap yalnızca transferlerde kullanılabilir.');
    if (t.contactId && !cid.has(t.contactId)) throw new InputError('Bir işlemin cari hesabı bulunamadı.');
    if (t.obligationId) {
      const o = obs.get(t.obligationId);
      if (!o || (o.type === 'receivable' && t.type !== 'income') || (o.type === 'payable' && t.type !== 'expense')) throw new InputError('İşlem ile vade uyumsuz.');
      if (t.contactId !== o.contactId) throw new InputError('Vade ve işlem cari hesapları uyuşmuyor.');
      paid.set(o.id, (paid.get(o.id) || 0) + t.amount);
    }
  }
  for (const o of obligations) if ((paid.get(o.id) || 0) > o.amount + 0.005) throw new InputError('Bir vade için fazla ödeme veya tahsilat girilmiş.');
  return { demo: Boolean(input.demo), accounts, contacts, transactions, obligations };
}
