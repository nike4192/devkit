import { input, password } from '@inquirer/prompts';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import chalk from 'chalk';
import { openBrowser } from '../browser.mjs';

/**
 * OAuth 2.0 implicit flow provider (response_type=token).
 *
 * Two flows:
 *   manual — opens authorize URL with redirect_uri=verification_code page.
 *            User copies token from the provider's page and pastes into CLI.
 *            Default — works without redirect_uri registration.
 *
 *   auto   — opens authorize URL with redirect_uri=http://localhost:PORT/path.
 *            Local HTTP server captures the fragment via a tiny JS bridge,
 *            CLI receives the token automatically. Requires the OAuth app
 *            to have that exact redirect URI registered.
 *
 * Spec fields:
 *   provider: oauth
 *   secret: true                  # mask manual paste
 *   oauth:
 *     authorize_url: REQUIRED     # e.g. https://oauth.yandex.ru/authorize
 *     response_type: token        # default; only implicit is supported
 *     client_id: ...              # OR client_id_var: NAME of env var
 *     scope: optional
 *     redirect_uri:               # optional — presence enables auto flow
 *                                 # if it points to http://localhost[:port]/path
 *     verification_url:           # manual-flow redirect, default for Yandex:
 *                                 # https://oauth.yandex.ru/verification_code
 */
export async function run({ name, spec }) {
  const oauth = spec.oauth || {};
  const authorizeUrl = oauth.authorize_url;
  const responseType = oauth.response_type || 'token';
  const scope = oauth.scope;
  const clientId = oauth.client_id_var
    ? process.env[oauth.client_id_var]
    : oauth.client_id;

  if (!authorizeUrl) {
    throw new Error(`oauth provider for ${name}: oauth.authorize_url is required`);
  }
  if (!clientId) {
    const hint = oauth.client_id_var
      ? `oauth.client_id_var=${oauth.client_id_var} not set in env or .env.example`
      : `oauth.client_id missing`;
    throw new Error(`oauth provider for ${name}: ${hint}`);
  }

  const isLocalhost = oauth.redirect_uri && /^http:\/\/localhost(:\d+)?(\/|$)/.test(oauth.redirect_uri);

  if (isLocalhost) {
    return await autoFlow({ name, spec, authorizeUrl, clientId, responseType, scope, oauth });
  }
  return await manualFlow({ name, spec, authorizeUrl, clientId, responseType, scope, oauth });
}

function buildAuthorizeUrl({ authorizeUrl, clientId, responseType, scope, redirectUri, state }) {
  const params = new URLSearchParams({ response_type: responseType, client_id: clientId, state });
  if (redirectUri) params.set('redirect_uri', redirectUri);
  if (scope) params.set('scope', scope);
  return `${authorizeUrl}?${params}`;
}

async function manualFlow({ name, spec, authorizeUrl, clientId, responseType, scope, oauth }) {
  const verificationUrl = oauth.verification_url || 'https://oauth.yandex.ru/verification_code';
  const state = randomBytes(8).toString('hex');
  const url = buildAuthorizeUrl({
    authorizeUrl, clientId, responseType, scope,
    redirectUri: verificationUrl, state,
  });

  console.log(chalk.cyan(`  → ${url}`));
  if (!openBrowser(url)) {
    console.log(chalk.yellow('  Could not auto-open browser. Open the URL above manually.'));
  }
  console.log(chalk.dim('  After clicking «Allow», copy the access token from the provider page.'));

  if (spec.hint) {
    for (const line of String(spec.hint).split('\n')) {
      if (line.trim()) console.log(chalk.dim(`  ${line}`));
    }
  }

  const ask = spec.secret ? password : input;
  const value = await ask({
    message: `Paste ${name}`,
    mask: spec.secret ? '*' : undefined,
    validate: (v) => v.trim().length > 0 || 'Token is required',
  });
  return value.trim();
}

async function autoFlow({ name, spec, authorizeUrl, clientId, responseType, scope, oauth }) {
  const redirectUri = oauth.redirect_uri;
  const u = new URL(redirectUri);
  const port = parseInt(u.port, 10) || 80;
  const callbackPath = u.pathname || '/callback';
  const state = randomBytes(16).toString('hex');

  let resolveToken, rejectToken;
  const tokenPromise = new Promise((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${port}`);

    if (reqUrl.pathname === callbackPath) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml(state));
      return;
    }

    if (reqUrl.pathname === '/__token') {
      const token = reqUrl.searchParams.get('access_token');
      const error = reqUrl.searchParams.get('error');
      const gotState = reqUrl.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      if (error) {
        rejectToken(new Error(`OAuth error: ${error}`));
      } else if (gotState !== state) {
        rejectToken(new Error('OAuth state mismatch (possible CSRF)'));
      } else if (token) {
        resolveToken(token);
      } else {
        rejectToken(new Error('OAuth callback received no access_token'));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', resolve);
  });

  const url = buildAuthorizeUrl({
    authorizeUrl, clientId, responseType, scope, redirectUri, state,
  });
  console.log(chalk.cyan(`  → ${url}`));
  console.log(chalk.dim(`  Listening on ${redirectUri} for redirect...`));
  if (!openBrowser(url)) {
    console.log(chalk.yellow('  Could not auto-open browser. Open the URL above manually.'));
  }

  const timeoutMs = (oauth.timeout_seconds || 300) * 1000;
  try {
    const token = await Promise.race([
      tokenPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for OAuth callback`)), timeoutMs),
      ),
    ]);
    return token;
  } finally {
    server.close();
  }
}

function callbackHtml(expectedState) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>devkit OAuth</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; }
  h1 { font-size: 22px; }
  p { color: #555; }
  .ok { color: #2a7a2a; }
  .err { color: #b22; }
</style></head>
<body>
<h1>devkit OAuth</h1>
<p id="status">Capturing token…</p>
<script>
(function(){
  var hash = window.location.hash.slice(1);
  var params = new URLSearchParams(hash);
  var token = params.get('access_token');
  var error = params.get('error') || params.get('error_description');
  var state = params.get('state');
  var status = document.getElementById('status');

  if (error) {
    status.className = 'err';
    status.textContent = 'OAuth error: ' + error;
    fetch('/__token?error=' + encodeURIComponent(error) + '&state=' + encodeURIComponent(state || ''));
    return;
  }
  if (!token) {
    status.className = 'err';
    status.textContent = 'No access_token in redirect URL.';
    fetch('/__token?error=no_token&state=' + encodeURIComponent(state || ''));
    return;
  }
  fetch('/__token?access_token=' + encodeURIComponent(token) + '&state=' + encodeURIComponent(state || ''))
    .then(function(){
      status.className = 'ok';
      status.textContent = 'Token delivered to devkit. You can close this tab.';
    })
    .catch(function(e){
      status.className = 'err';
      status.textContent = 'Failed to deliver token: ' + e;
    });
})();
</script>
</body></html>`;
}
