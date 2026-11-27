/* Offline behavioral tests of the actual staged JS, with a mocked browser and
 * Supabase adapter. No real backend, browser, service worker, or auth session.
 * Run: node tests/test_agenda_runtime.cjs
 * IMPORTANT: the offline legacy reconnection regression is intentionally RED
 * until local changes can be recovered without silently overwriting the cloud.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const begin = html.indexOf('const SB = window.supabase.createClient');
const syncCode = html.slice(begin, html.indexOf('function usePersist(', begin));
const pullStart = html.indexOf('async function pullRemote(uidv) {');
const appStart = html.indexOf('\nfunction App() {', pullStart);
const pullCode = html.slice(pullStart, appStart);
const appCode = html.slice(appStart, html.indexOf('\ntry{\n  ReactDOM.createRoot', appStart));
if (begin < 0 || pullStart < 0 || appStart < 0 || !syncCode || !pullCode || !appCode) throw Error('app entry points not found');

function fixture(options = {}) {
  const storage = new Map(), writes = [], states = [], effects = [];
  let signouts = 0;
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    key: i => Array.from(storage.keys())[i],
    get length() { return storage.size; },
  };
  const supabase = {
    rpc: async (name, args) => name === 'agenda_sync_enabled'
      ? { data: options.flag ?? false, error: null }
      : options.cas ? options.cas(args) : { data: { status: 'applied', version: (args.p_expected_version || 0) + 1 }, error: null },
    from: table => ({
      upsert: async rows => { writes.push(JSON.parse(JSON.stringify(rows))); return options.upsert ? options.upsert(rows) : { error: null }; },
      select: () => ({ eq: () => table === 'kv'
        ? Promise.resolve({ data: options.remote ?? [], error: null })
        : { range: () => Promise.resolve({ data: options.items ?? [], error: null }) } }),
    }),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'test-user' } } } }),
      getUser: async () => options.authUser ?? { data: { user: { id: 'test-user' } }, error: null },
      signOut: async () => { signouts++; return { error: null }; },
    },
  };
  const navigator = { onLine: options.online ?? true };
  const sandbox = {
    console, localStorage, navigator,
    window: { supabase: { createClient: () => supabase }, addEventListener: () => {}, dispatchEvent: () => {} },
    document: { visibilityState: 'visible' }, Event: class {}, location: { reload: () => {} },
    setTimeout: () => 1, clearTimeout: () => {},
    React: { createElement: (type, props) => ({ type, props }) }, LoginScreen: 'login', AppInner: 'inner',
    useState: value => { const i = states.push(value) - 1; return [value, next => states[i] = next]; },
    useEffect: effect => effects.push(effect), alert: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext('const _memCache={};\n' + syncCode + '\n' + pullCode + '\n' + appCode, sandbox);
  return { sandbox, storage, writes, states, effects, navigator, get signouts() { return signouts; } };
}
const run = (x, code) => vm.runInContext(code, x.sandbox);
const tests = [
  ['empty normalized cloud preserves existing local agenda', async () => {
    const x = fixture({ flag: true, items: [] });
    x.storage.set('agendaplus_events', JSON.stringify([{ id: 'x', title: 'local' }]));
    await run(x, "pullRemote('test-user')");
    assert.equal(JSON.parse(x.storage.get('agendaplus_events'))[0]?.title, 'local');
  }],
  ['offline cached session opens local app without signing out', async () => {
    const x = fixture({ online: false, authUser: { data: { user: null }, error: { message: 'network' } } });
    run(x, 'App()'); await x.effects[0](); await new Promise(resolve => setImmediate(resolve));
    assert.equal(x.signouts, 0); assert.equal(x.states[0], 'app');
  }],
  ['online rejected account is not accepted as cached offline session', async () => {
    const x = fixture({ online: true, authUser: { data: { user: null }, error: { message: 'unauthorized' } } });
    run(x, 'App()'); await x.effects[0](); await new Promise(resolve => setImmediate(resolve));
    assert.equal(x.signouts, 1); assert.equal(x.states[0], 'login');
  }],
  ['denied legacy mixed batch retries only preference rows', async () => {
    const x = fixture({ upsert: rows => ({ error: rows.some(row => row.key === 'agendaplus_events') ? { code: '42501' } : null }) });
    const result = await run(x, `_agendaGateKnown=true;_agendaSyncEnabled=false;_writeKvRows('test-user',[{key:'agendaplus_events',value:[{id:'x'}]},{key:'agendaplus_theme',value:'dark'}])`);
    assert.equal(result.agendaBlocked, true); assert.equal(x.writes.length, 2); assert.deepEqual(x.writes[1].map(row => row.key), ['agendaplus_theme']);
  }],
  ['stale CAS conflict retains local item and cloud version', async () => {
    const x = fixture({ flag: true, cas: () => ({ data: { status: 'conflict', version: 2, payload: { id: 'x', title: 'remote' } }, error: null }) });
    const ok = await run(x, `_agendaSyncEnabled=true;_agendaGateKnown=true;_agendaLoadMeta('test-user');_agendaMeta.versions['event:x']=1;_agendaMeta.pending['event:x']={type:'event',id:'x',deleted:false,payload:{id:'x',title:'local'},baseVersion:1};_agendaDrain()`);
    const meta = run(x, `_agendaMeta`);
    assert.equal(ok, false); assert.equal(meta.pending['event:x'].payload.title, 'local'); assert.equal(meta.conflicts['event:x'].version, 2);
  }],
  ['offline legacy edit survives flush and reconnect', async () => {
    const x = fixture({ online: false, flag: false, remote: [{ key: 'agendaplus_events', value: [{ id: 'x', title: 'old remote' }] }] });
    x.storage.set('agendaplus_events', JSON.stringify([{ id: 'x', title: 'old remote' }]));
    await run(x, `_sbUser='test-user';_agendaSyncEnabled=false;_refreshAgendaGate('test-user')`);
    await run(x, `_lsSet('agendaplus_events',[{id:'x',title:'new offline'}]);_sbFlush()`);
    x.navigator.onLine = true; await run(x, `pullRemote('test-user')`);
    assert.equal(JSON.parse(x.storage.get('agendaplus_events'))[0]?.title, 'new offline', 'offline edit must never be silently replaced by old cloud data');
  }],
];
(async () => {
  let failed = 0;
  for (const [name, test] of tests) {
    try { await test(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
})();
