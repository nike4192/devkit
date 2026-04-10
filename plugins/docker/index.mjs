import chalk from 'chalk';

function handleError(e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

/**
 * Register docker plugin commands.
 * @param {import('commander').Command} program
 * @param {object} context
 */
export function register(program, { config, utils, projectRoot, devkitRoot }) {
  const dockerCmd = program
    .command('docker')
    .description(config.description || 'Docker environment management');

  dockerCmd
    .command('setup')
    .description('Create required Docker networks (external networks from compose)')
    .action(() => {
      try {
        const composeFile = config.compose_file || 'docker-compose.dev.yml';
        const networks = utils.getComposeExternalNetworks(projectRoot, composeFile);
        if (networks.length === 0) {
          console.log('No external networks found in compose file.');
          return;
        }
        const created = utils.ensureDockerNetworks(projectRoot, composeFile);
        for (const net of networks) {
          if (created.includes(net)) {
            console.log(chalk.green(`  Created network: ${net}`));
          } else {
            console.log(`  Network exists: ${net}`);
          }
        }
        console.log(chalk.green('Done!'));
      } catch (e) {
        handleError(e);
      }
    });
}
