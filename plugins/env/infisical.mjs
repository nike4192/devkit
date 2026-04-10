import chalk from 'chalk';
import { execSync } from 'child_process';

/**
 * Get Infisical credentials from config + environment variables.
 */
function getInfisicalCredentials(config) {
  const infisical = config.infisical || {};
  const clientIdEnv = infisical.client_id_env || 'INFISICAL_UNIVERSAL_AUTH_CLIENT_ID';
  const clientSecretEnv = infisical.client_secret_env || 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET';

  return {
    siteUrl: infisical.site_url,
    projectId: infisical.project_id,
    clientId: process.env[clientIdEnv],
    clientSecret: process.env[clientSecretEnv],
  };
}

export async function list({ config, utils, env = 'dev', path = '/' }) {
  const creds = getInfisicalCredentials(config);
  const secrets = await utils.fetchInfisicalSecrets({
    ...creds, envSlug: env, secretPath: path,
  });
  if (secrets.length === 0) { console.log('No secrets.'); return; }

  for (const s of secrets) {
    console.log(`${s.secretKey}=${s.secretValue}`);
  }
}

export async function get({ config, utils, name, env = 'dev', path = '/' }) {
  const creds = getInfisicalCredentials(config);
  const client = await utils.getInfisicalClient(creds);
  const secret = await client.getSecret({
    projectId: creds.projectId,
    environment: env,
    path,
    secretName: name,
  });
  console.log(secret.secretValue);
}

export async function set({ config, utils, keyValue, env = 'dev', path = '/' }) {
  const idx = keyValue.indexOf('=');
  if (idx === -1) throw new Error('Format: KEY=VALUE');

  const key = keyValue.slice(0, idx);
  const value = keyValue.slice(idx + 1);

  const creds = getInfisicalCredentials(config);
  const client = await utils.getInfisicalClient(creds);

  try {
    await client.updateSecret({
      projectId: creds.projectId,
      environment: env,
      path,
      secretName: key,
      secretValue: value,
    });
  } catch {
    await client.createSecret({
      projectId: creds.projectId,
      environment: env,
      path,
      secretName: key,
      secretValue: value,
    });
  }

  console.log(chalk.green(`\u2713 ${key} updated`));
}

export async function del({ config, utils, name, env = 'dev', path = '/' }) {
  const creds = getInfisicalCredentials(config);
  const client = await utils.getInfisicalClient(creds);
  await client.deleteSecret({
    projectId: creds.projectId,
    environment: env,
    path,
    secretName: name,
  });
  console.log(chalk.green(`\u2713 ${name} deleted`));
}

export async function deploy({ config, utils, env, yes = false }) {
  if (!env) throw new Error('Specify --env (test or stage)');

  const servers = config.servers || {};
  const server = servers[env];
  if (!server) throw new Error(`No server for environment '${env}' (available: ${Object.keys(servers).join(', ')})`);

  if (server.confirm && !yes) {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question(chalk.yellow(`Deploy to ${env} (${server.ssh}). Continue? (y/N) `), resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== 'y') { console.log('Cancelled'); return; }
  }

  console.log(chalk.cyan(`\nDeploying secrets to ${env} (${server.ssh})...\n`));

  const containers = config.containers || {};
  const creds = getInfisicalCredentials(config);

  for (const [project, variants] of Object.entries(containers)) {
    for (const [variant, container] of Object.entries(variants)) {
      const secretPath = `/${project}/${variant}`;
      const remotePath = `${server.projects_path}/${project}/config/.env.${variant}`;

      process.stdout.write(`  ${project}/${variant}: `);

      try {
        const secrets = await utils.fetchInfisicalSecrets({
          ...creds, envSlug: env, secretPath,
        });
        if (secrets.length === 0) {
          console.log(chalk.dim('no secrets — skip'));
          continue;
        }

        const secretsMap = {};
        for (const s of secrets) secretsMap[s.secretKey] = s.secretValue;

        const currentEnv = utils.sshReadFile(server.ssh, remotePath);
        if (!currentEnv) {
          console.log(chalk.yellow('file not found — skip'));
          continue;
        }

        const { content, updated } = utils.mergeSecretsIntoEnv(currentEnv, secretsMap);
        utils.sshWriteFile(server.ssh, remotePath, content);

        let restartOk = false;
        try {
          execSync(`ssh ${server.ssh} 'docker restart ${container}'`, { encoding: 'utf-8', timeout: 30000 });
          restartOk = true;
        } catch {}

        const status = restartOk ? chalk.green(container) : chalk.red(`${container} not restarted`);
        console.log(chalk.green(`${updated} secrets`) + chalk.dim(' \u2192 ') + status);
      } catch (e) {
        console.log(chalk.red(`error: ${e.message}`));
      }
    }
  }

  console.log(chalk.green('\n\u2713 Deploy complete'));
}
