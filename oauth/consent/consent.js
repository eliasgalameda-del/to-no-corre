(() => {
  'use strict';
  const SUPABASE_URL = 'https://myuwytzbkckemcyfvhkx.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_txj23eTRYdEHQ425y3u73Q_cSnPYtjH';
  const screens = ['loading', 'missing', 'login', 'consent', 'already', 'done', 'fatal'];
  const byId = (id) => document.getElementById(id);
  let sb;
  let authorizationId = '';
  let authorizationDetails = null;
  let busy = false;
  let signupMode = false;

  function screen(name) { for (const item of screens) byId(item).classList.toggle('hidden', item !== name); }
  function safeText(id, value, fallback) { byId(id).textContent = typeof value === 'string' && value.trim() ? value.trim() : fallback; }
  function showError(id, message) { const box = byId(id); box.textContent = message; box.classList.remove('hidden'); }
  function clearError(id) { const box = byId(id); box.textContent = ''; box.classList.add('hidden'); }
  function fail(message) { safeText('fatal-message', message || 'A solicitação pode ter expirado ou não ser válida. Volte ao cliente e inicie a conexão novamente.', 'Não conseguimos validar a solicitação.'); screen('fatal'); }
  function setBusy(value) {
    busy = value;
    for (const id of ['approve', 'deny', 'continue', 'login-submit', 'mode-toggle', 'switch-account']) {
      const button = byId(id); if (button) button.disabled = value;
    }
  }
  function clientName(details) {
    const client = details && details.client;
    return client && (client.name || client.client_name) || details && details.client_name || 'Aplicativo externo';
  }
  function clientId(details) {
    const client = details && details.client;
    return details && (details.client_id || details.clientId) || client && (client.client_id || client.clientId || client.id) || '';
  }
  function scopeList(details) {
    const raw = typeof details.scope === 'string' ? details.scope.trim() : '';
    const list = byId('scopes'); list.replaceChildren();
    if (!raw) { const li = document.createElement('li'); li.textContent = 'Nenhum escopo OAuth explícito foi solicitado.'; list.appendChild(li); return; }
    const known = {
      openid: 'Solicita autenticação OpenID Connect.',
      email: 'Solicita acesso ao endereço de e-mail da conta.',
      profile: 'Solicita dados básicos de perfil disponibilizados pelo provedor.',
      mcp: 'Escopo de acesso ao servidor MCP; as ferramentas disponíveis são determinadas pelo próprio servidor.'
    };
    const seen = new Set();
    for (const token of raw.split(/\s+/).filter(Boolean)) {
      if (seen.has(token)) continue;
      seen.add(token);
      const li = document.createElement('li');
      const code = document.createElement('span'); code.className = 'scope-code'; code.textContent = token; li.appendChild(code);
      if (known[token]) { const help = document.createElement('span'); help.className = 'scope-help'; help.textContent = known[token]; li.appendChild(help); }
      list.appendChild(li);
    }
  }
  function safeReturnUrl(returnUrl, registeredUri) {
    let target, registered;
    try { target = new URL(returnUrl); registered = registeredUri ? new URL(registeredUri) : null; }
    catch (_) { return null; }
    const localDev = target.protocol === 'http:' && (target.hostname === 'localhost' || target.hostname === '127.0.0.1');
    if (target.protocol !== 'https:' && !localDev) return null;
    if (registered && (registered.protocol !== target.protocol || registered.origin !== target.origin || registered.pathname !== target.pathname)) return null;
    return target.href;
  }
  function showDetails(details, user) {
    authorizationDetails = details;
    safeText('client-name', clientName(details), 'Aplicativo externo');
    const id = clientId(details);
    safeText('client-id', id ? `ID do cliente: ${id}` : '', '');
    const redirectUri = typeof details.redirect_uri === 'string' ? details.redirect_uri : '';
    safeText('redirect-uri', redirectUri ? `Destino de retorno registrado: ${redirectUri}` : '', 'Destino de retorno não informado');
    safeText('account-email', user && user.email ? `Conta conectada: ${user.email}` : 'Conta conectada e verificada.');
    scopeList(details);
  }
  async function currentUser() {
    const { data: sessionData, error: sessionError } = await sb.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) return null;
    const { data, error } = await sb.auth.getUser();
    if (error || !data.user) return null;
    return data.user;
  }
  async function loadRequest() {
    if (!authorizationId) { screen('missing'); return; }
    const user = await currentUser();
    if (!user) { screen('login'); return; }
    if (!sb.auth.oauth || typeof sb.auth.oauth.getAuthorizationDetails !== 'function') {
      fail('A biblioteca de autenticação não oferece suporte a esta autorização. Atualize e tente novamente.'); return;
    }
    let result;
    try { result = await sb.auth.oauth.getAuthorizationDetails(authorizationId); }
    catch (_) { fail(); return; }
    if (!result || result.error || !result.data || typeof result.data !== 'object') { fail(); return; }
    const details = result.data;
    if (details.authorization_id && details.authorization_id !== authorizationId) { fail(); return; }
    if (!details.authorization_id && typeof details.redirect_url === 'string') {
      authorizationDetails = details;
      const summary = `${clientName(details)}${clientId(details) ? ` · ID: ${clientId(details)}` : ''}`;
      safeText('already-details', summary, 'Aplicativo externo');
      const target = safeReturnUrl(details.redirect_url, details.redirect_uri);
      if (!target) { byId('continue').disabled = true; showError('already-error', 'O endereço de retorno não corresponde ao destino registrado. Não é seguro continuar.'); }
      else byId('continue').dataset.target = target;
      screen('already'); return;
    }
    if (!details.authorization_id && !details.redirect_uri && !details.scope && !details.client) { fail(); return; }
    showDetails(details, user);
    screen('consent');
  }
  async function decide(approve) {
    if (busy || !authorizationId || !authorizationDetails) return;
    setBusy(true); clearError('decision-error');
    try {
      const method = approve ? sb.auth.oauth.approveAuthorization : sb.auth.oauth.denyAuthorization;
      if (typeof method !== 'function') throw new Error('unsupported');
      const { data, error } = await method.call(sb.auth.oauth, authorizationId);
      if (error || !data || typeof data.redirect_url !== 'string') throw new Error('invalid');
      const target = safeReturnUrl(data.redirect_url, authorizationDetails.redirect_uri);
      if (!target) throw new Error('redirect');
      screen('done'); window.location.assign(target);
    } catch (_) {
      showError('decision-error', 'Não foi possível processar a escolha. O pedido pode ter expirado ou sido usado; reinicie a conexão no cliente.');
      setBusy(false);
    }
  }
  function callbackUrl() {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('authorization_id', authorizationId);
    return url.href;
  }
  async function submitLogin(event) {
    event.preventDefault(); if (busy) return;
    clearError('login-error');
    const email = byId('email').value.trim();
    const password = byId('password').value;
    const password2 = byId('password2').value;
    if (!email || !password) { showError('login-error', 'Preencha e-mail e senha.'); return; }
    if (signupMode && (password.length < 6 || password !== password2)) { showError('login-error', 'Confira as senhas (mínimo de 6 caracteres e iguais).'); return; }
    setBusy(true);
    try {
      const result = signupMode
        ? await sb.auth.signUp({ email, password, options: { emailRedirectTo: callbackUrl() } })
        : await sb.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (!result.data.session) {
        showError('login-error', 'Conta criada. Confirme seu e-mail e volte a esta página. Se o pedido tiver expirado, reinicie a conexão no cliente.');
        setBusy(false); return;
      }
      await loadRequest();
    } catch (_) { showError('login-error', signupMode ? 'Não foi possível criar a conta. Verifique os dados e tente novamente.' : 'Não foi possível entrar. Confira o e-mail e a senha.'); }
    finally { setBusy(false); }
  }
  function toggleMode() {
    signupMode = !signupMode;
    byId('password2-wrap').classList.toggle('hidden', !signupMode);
    byId('password2').required = signupMode;
    byId('password').autocomplete = signupMode ? 'new-password' : 'current-password';
    byId('login-submit').textContent = signupMode ? 'Criar conta' : 'Entrar';
    byId('mode-toggle').textContent = signupMode ? 'Já tem conta? Entrar' : 'Primeira vez? Criar conta';
    clearError('login-error');
  }
  async function useAnotherAccount() {
    if (busy) return; setBusy(true);
    try { const { error } = await sb.auth.signOut(); if (error) throw error; screen('login'); }
    catch (_) { showError('decision-error', 'Não foi possível sair desta conta neste momento.'); }
    finally { setBusy(false); }
  }
  async function init() {
    if (window.top !== window.self) {
      document.body.textContent = 'Por segurança, a tela de autorização não pode ser exibida dentro de outra página.';
      document.body.style.visibility = 'visible'; return;
    }
    document.body.style.visibility = 'visible';
    const url = new URL(window.location.href);
    authorizationId = url.searchParams.get('authorization_id') || '';
    if (authorizationId.length > 2048 || /[\u0000-\u001f\u007f]/.test(authorizationId)) authorizationId = '';
    if (!authorizationId) { screen('missing'); return; }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') { fail('Não foi possível carregar o serviço de autenticação.'); return; }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    byId('login-form').addEventListener('submit', submitLogin);
    byId('mode-toggle').addEventListener('click', toggleMode);
    byId('approve').addEventListener('click', () => decide(true));
    byId('deny').addEventListener('click', () => decide(false));
    byId('continue').addEventListener('click', () => {
      const target = byId('continue').dataset.target;
      if (target && safeReturnUrl(target, authorizationDetails && authorizationDetails.redirect_uri)) window.location.assign(target);
      else showError('already-error', 'Não é seguro abrir este destino. Reinicie a conexão no cliente.');
    });
    byId('switch-account').addEventListener('click', useAnotherAccount);
    try { await loadRequest(); } catch (_) { fail(); }
  }
  window.addEventListener('DOMContentLoaded', () => { init().catch(() => fail()); }, { once: true });
})();
