import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getMiniprogramProjectPaths, isMiniprogramCustomApiEnabled } from './storage.js';

export interface MiniprogramBuildResult {
  ok: boolean;
  install_output: string;
  build_output: string;
  dist_index_path: string;
}

export async function buildMiniprogramProject(appId: string): Promise<MiniprogramBuildResult> {
  const paths = getMiniprogramProjectPaths(appId);
  const packageJsonPath = path.join(paths.appDir, 'package.json');
  const serverPackageJsonPath = path.join(paths.serverDir, 'package.json');
  const distIndexPath = path.join(paths.distDir, 'index.html');
  const cacheDir = path.join(paths.rootDir, '.npm-cache');
  const homeDir = path.join(paths.rootDir, '.npm-home');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found: ${packageJsonPath}`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  const installOutput = await runCommand(
    resolveNpmCommand(),
    ['install', '--no-fund', '--no-audit', '--cache', cacheDir],
    paths.appDir,
    {
      npm_config_cache: cacheDir,
      HOME: homeDir,
    },
  );
  let serverInstallOutput = '';
  if (isMiniprogramCustomApiEnabled(appId) && fs.existsSync(serverPackageJsonPath)) {
    serverInstallOutput = await runCommand(
      resolveNpmCommand(),
      ['install', '--no-fund', '--no-audit', '--cache', cacheDir],
      paths.serverDir,
      {
        npm_config_cache: cacheDir,
        HOME: homeDir,
      },
    );
  }
  const buildOutput = await runCommand(
    resolveNpmCommand(),
    ['run', 'build'],
    paths.appDir,
    {
      npm_config_cache: cacheDir,
      HOME: homeDir,
    },
  );

  if (!fs.existsSync(distIndexPath)) {
    throw new Error(`Build completed but dist/index.html is missing: ${distIndexPath}`);
  }

  return {
    ok: true,
    install_output: [installOutput, serverInstallOutput].filter(Boolean).join('\n\n'),
    build_output: buildOutput,
    dist_index_path: distIndexPath,
  };
}

function resolveNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(trimOutput(output));
      } else {
        reject(
          new Error(
            trimOutput(output) ||
              `${command} ${args.join(' ')} exited with code ${code}`,
          ),
        );
      }
    });
  });
}

function trimOutput(output: string): string {
  const lines = output.trim().split('\n');
  return lines.slice(-120).join('\n');
}
