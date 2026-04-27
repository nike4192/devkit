import { resolve } from 'path';
import { existsSync, readFileSync, copyFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import chalk from 'chalk';

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

function hasInfisical(config) {
  const creds = getInfisicalCredentials(config);
  return !!(creds.siteUrl && creds.projectId && creds.clientId && creds.clientSecret);
}

/**
 * Optionally validate .env against .env.schema if envschema is installed.
 */
function validateWithEnvSchema(envFile, schemaFile) {
  if (!existsSync(schemaFile)) return;

  try {
    execSync('command -v envschema', { stdio: 'pipe' });
  } catch {
    console.log(chalk.dim('  hint: install envschema-dsl for .env validation'));
    return;
  }

  try {
    execSync(`envschema validate "${schemaFile}" --env "${envFile}"`, {
      stdio: 'pipe', encoding: 'utf-8',
    });
    console.log(chalk.green('  .env.schema validation passed'));
  } catch (e) {
    const raw = (e.stdout || e.stderr || e.message).trimEnd();
    // Strip ANSI escape sequences to prevent color bleeding
    const output = raw.replace(/\x1b\[[0-9;]*m/g, '');
    console.log(chalk.yellow('  .env.schema validation warnings:'));
    console.log(output);
  }
}

// --- Commands ---

export async function status({ config, utils, projectRoot }) {
  const subprojects = config.subprojects || {};

  if (Object.keys(subprojects).length === 0) {
    console.log(chalk.yellow('No subprojects configured. Add them to .devkit.d/env.yml'));
    return;
  }

  for (const [name, cfg] of Object.entries(subprojects)) {
    console.log(chalk.cyan.bold(`\n${name}`));
    const basePath = resolve(projectRoot, cfg.path || '.');
    console.log(`  path: ${basePath}`);

    if (!existsSync(basePath)) {
      console.log(chalk.red('  directory not found'));
      continue;
    }

    for (const variant of (cfg.variants || [])) {
      const configDir = resolve(basePath, cfg.config_dir || 'config');
      const exampleFile = resolve(configDir, `.env.${variant}.example`);
      const envFile = resolve(configDir, `.env.${variant}`);

      const parts = [];
      parts.push(existsSync(exampleFile) ? chalk.green('example') : chalk.yellow('no example'));
      parts.push(existsSync(envFile) ? chalk.green('.env') : chalk.red('no .env'));

      console.log(`  ${variant}: ${parts.join(' | ')}`);
    }
  }
}

export async function init({ config, utils, projectRoot, envName = 'dev', force = false }) {
  const subprojects = config.subprojects || {};

  if (Object.keys(subprojects).length === 0) {
    console.log(chalk.yellow('No subprojects configured. Add them to .devkit.d/env.yml'));
    return;
  }

  // Root .env (devkit secrets from Infisical path /)
  if (hasInfisical(config)) {
    const exampleFile = resolve(projectRoot, '.env.example');
    const envFile = resolve(projectRoot, '.env');

    console.log(chalk.cyan.bold('\ndevkit (root)'));

    if (existsSync(exampleFile)) {
      if (!existsSync(envFile) || force) {
        copyFileSync(exampleFile, envFile);
        const action = force && existsSync(envFile) ? 'overwritten' : 'created';
        console.log(`  .env ${action} from .env.example`);
      } else {
        console.log(`  .env exists (skip)`);
      }
    }

    if (existsSync(envFile)) {
      try {
        const creds = getInfisicalCredentials(config);
        const secrets = await utils.fetchInfisicalSecrets({
          ...creds, envSlug: envName, secretPath: '/',
        });
        if (secrets.length > 0) {
          const secretsMap = {};
          for (const s of secrets) secretsMap[s.secretKey] = s.secretValue;
          const envContent = readFileSync(envFile, 'utf-8');
          const { content, updated } = utils.mergeSecretsIntoEnv(envContent, secretsMap);
          writeFileSync(envFile, content);
          console.log(chalk.green(`  +${updated} secrets from Infisical (/)`));
        }
      } catch (e) {
        console.log(chalk.red(`  Infisical error: ${e.message}`));
      }
    }
  }

  for (const [name, cfg] of Object.entries(subprojects)) {
    const basePath = resolve(projectRoot, cfg.path || '.');
    if (!existsSync(basePath)) {
      console.log(chalk.red(`  ${name}: directory not found (${basePath})`));
      continue;
    }

    console.log(chalk.cyan.bold(`\n${name}`));

    for (const variant of (cfg.variants || [])) {
      const configDir = resolve(basePath, cfg.config_dir || 'config');
      const exampleFile = resolve(configDir, `.env.${variant}.example`);
      const envFile = resolve(configDir, `.env.${variant}`);

      // Step 1: copy example → .env
      if (existsSync(exampleFile)) {
        if (!existsSync(envFile) || force) {
          copyFileSync(exampleFile, envFile);
          const action = force && existsSync(envFile) ? 'overwritten' : 'created';
          console.log(`  ${variant}: .env.${variant} ${action} from example`);
        } else {
          console.log(`  ${variant}: .env.${variant} exists (skip)`);
        }
      } else {
        console.log(chalk.yellow(`  ${variant}: .env.${variant}.example not found`));
        if (!existsSync(envFile)) continue;
      }

      // Step 2: pull secrets from Infisical
      if (hasInfisical(config)) {
        try {
          const infisicalPath = (cfg.infisical_path || '/{project}/{variant}')
            .replace('{project}', name)
            .replace('{variant}', variant);
          const creds = getInfisicalCredentials(config);
          const secrets = await utils.fetchInfisicalSecrets({
            ...creds, envSlug: envName, secretPath: infisicalPath,
          });
          if (secrets.length > 0) {
            const secretsMap = {};
            for (const s of secrets) secretsMap[s.secretKey] = s.secretValue;
            if (secretsMap.DB_PASSWORD) {
              secretsMap.POSTGRES_PASSWORD = secretsMap.DB_PASSWORD;
            }
            const envContent = readFileSync(envFile, 'utf-8');
            const { content, updated } = utils.mergeSecretsIntoEnv(envContent, secretsMap);
            writeFileSync(envFile, content);
            console.log(chalk.green(`  ${variant}: +${updated} secrets from Infisical (${infisicalPath})`));
          } else {
            console.log(`  ${variant}: no secrets in Infisical (${infisicalPath})`);
          }
        } catch (e) {
          console.log(chalk.red(`  ${variant}: Infisical error: ${e.message}`));
        }
      }

      // Step 3: validate with env-schema
      const schemaFile = resolve(configDir, '.env.schema');
      validateWithEnvSchema(envFile, schemaFile);
    }
  }

  console.log(chalk.green('\nDone!'));
}

export async function pullSecrets({ config, utils, projectRoot, envName = 'dev' }) {
  const subprojects = config.subprojects || {};

  if (!hasInfisical(config)) {
    const creds = getInfisicalCredentials(config);
    const missing = [];
    if (!creds.siteUrl) missing.push('infisical.site_url (.devkit.d/env.yml)');
    if (!creds.projectId) missing.push('infisical.project_id (.devkit.d/env.yml)');
    if (!creds.clientId) missing.push(`${config.infisical?.client_id_env || 'INFISICAL_UNIVERSAL_AUTH_CLIENT_ID'} env var`);
    if (!creds.clientSecret) missing.push(`${config.infisical?.client_secret_env || 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET'} env var`);
    console.log(chalk.yellow('Infisical not configured. Missing:'));
    for (const m of missing) console.log(chalk.dim(`  - ${m}`));
    console.log(chalk.dim('\nMachine Identity creds → Infisical UI → Access Control → Identities → Universal Auth.'));
    console.log(chalk.dim('Add INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET to project .env.'));
    return;
  }

  for (const [name, cfg] of Object.entries(subprojects)) {
    const basePath = resolve(projectRoot, cfg.path || '.');
    if (!existsSync(basePath)) continue;

    console.log(chalk.cyan.bold(`\n${name}`));

    for (const variant of (cfg.variants || [])) {
      const configDir = resolve(basePath, cfg.config_dir || 'config');
      const envFile = resolve(configDir, `.env.${variant}`);

      if (!existsSync(envFile)) {
        console.log(chalk.yellow(`  ${variant}: .env.${variant} not found (run env init)`));
        continue;
      }

      try {
        const infisicalPath = (cfg.infisical_path || '/{project}/{variant}')
          .replace('{project}', name)
          .replace('{variant}', variant);
        const creds = getInfisicalCredentials(config);
        const secrets = await utils.fetchInfisicalSecrets({
          ...creds, envSlug: envName, secretPath: infisicalPath,
        });
        if (secrets.length > 0) {
          const secretsMap = {};
          for (const s of secrets) secretsMap[s.secretKey] = s.secretValue;
          if (secretsMap.DB_PASSWORD) {
            secretsMap.POSTGRES_PASSWORD = secretsMap.DB_PASSWORD;
          }
          const envContent = readFileSync(envFile, 'utf-8');
          const { content, updated } = utils.mergeSecretsIntoEnv(envContent, secretsMap);
          writeFileSync(envFile, content);
          console.log(chalk.green(`  ${variant}: updated ${updated} secrets`));
        } else {
          console.log(`  ${variant}: no secrets in ${infisicalPath}`);
        }
      } catch (e) {
        console.log(chalk.red(`  ${variant}: error: ${e.message}`));
      }

      // Validate
      const schemaFile = resolve(configDir, '.env.schema');
      validateWithEnvSchema(envFile, schemaFile);
    }
  }

  console.log(chalk.green('\nDone!'));
}
