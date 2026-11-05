import test from 'node:test';
import assert from 'node:assert/strict';
import { blank, validateFinance, hashPassword, verifyPassword, validUsername, validPassword } from '../server/security.js';

const fixture = () => ({
  demo:false,
  accounts:[{id:'bank_1',name:'İş Bankası',bank:'İş Bankası',opening:10000},{id:'cash_1',name:'Kasa',bank:'Kasa',opening:0}],
  contacts:[{id:'firm_1',name:'Firma A',type:'customer',phone:'',email:''}],
  obligations:[{id:'obl_1',type:'receivable',contactId:'firm_1',amount:1000,dueDate:'2026-11-12',description:'Fatura'}],
  transactions:[{id:'txn_1',type:'income',amount:250,date:'2026-11-04',description:'Kısmi tahsilat',category:'Tahsilat',accountId:'bank_1',toAccountId:null,contactId:'firm_1',obligationId:'obl_1'}]
});

test('blank state and current financial data are accepted',()=>{
  assert.equal(validateFinance(blank()).accounts.length,0);
  assert.equal(validateFinance(fixture()).transactions[0].amount,250);
});
test('bad references, invalid amounts and overpayment are blocked',()=>{
  const f=fixture();f.transactions[0].amount=1250;
  assert.throws(()=>validateFinance(f),/fazla ödeme/);
  f.transactions[0].amount=250; f.transactions[0].accountId='fake';
  assert.throws(()=>validateFinance(f),/hesabı bulunamadı/);
  f.transactions[0].accountId='bank_1';f.transactions[0].amount=-50;
  assert.throws(()=>validateFinance(f),/tutarı/);
});
test('duplicate IDs and invalid dates are rejected',()=>{
  const f=fixture();f.accounts.push({...f.accounts[0]});
  assert.throws(()=>validateFinance(f),/yinelenen/);
  f.accounts.pop();f.transactions[0].date='2026-02-30';
  assert.throws(()=>validateFinance(f),/tarihi geçersiz/);
});
test('username/password restrictions',()=>{
  assert.equal(validUsername('user.1'),true);
  assert.equal(validUsername('başkan'),false);
  assert.equal(validPassword('Passw0rd!'),false);
  assert.equal(validPassword('LongPassword2026!'),true);
});
test('passwords are stored with salted scrypt and verified safely',async()=>{
  const first=await hashPassword('TestStrongPass#2026');
  const second=await hashPassword('TestStrongPass#2026');
  assert.notEqual(first,second);
  assert.equal(await verifyPassword('TestStrongPass#2026',first),true);
  assert.equal(await verifyPassword('wrong',first),false);
});
