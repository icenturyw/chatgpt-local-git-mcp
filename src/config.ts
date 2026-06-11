import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { AppConfig, RepoConfig, RepoRuntime } from './types.js';

const DEFAULT_CONFIG: Omit<AppConfig, 'repos'> = {
  server: {
    host: '0.0.0.0',
    port: 3000,
    mcpPath: '/mcp',
    maxRequestBodyBytes: 2 * 1024 * 1024,
  },
  security: {
    requireExpectedShaForOverwrite: true,
    maxReadBytes: 256 * 1024,
    maxWriteBytes: 256 * 1024,
    commandTimeoutMs: 120_000,
    globalDeniedPaths: [
      '.git',
      '.env',
      '.env.*',
      'id_rsa',
      'id_ed25519',
      '*.pem',
      '*.key',
      'secrets',
      'node_modules',
      '__pycache__',
    ],
  },
  auth: {
    bearerTokenEnv: 'MCP_AUTH_TOKEN',
  },
};

function findConfigPath(): string {
  const fromEnv = process.env.CONFIG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const cwd = process.cwd();
  const candidates = [path.join(cwd, 'config.yaml'), path.join(cwd, 'config.example.yaml')];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('No config file found. Copy config.example.yaml to config.yaml and edit repo paths.');
  }
  return found;
}

function ensureMcpPath(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : '/mcp';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function discoverReposInDir(dirPath: string): Record<string, RepoConfig> {
  const repos: Record<string, RepoConfig> = {};

  if (!fs.existsSync(dirPath)) {
    console.warn(`reposDir '${dirPath}' does not exist, skipping auto-discovery.`);
    return repos;
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    console.warn(`reposDir '${dirPath}' is not a directory, skipping auto-discovery.`);
    return repos;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(dirPath, entry.name);
    const gitDir = path.join(repoPath, '.git');
    if (!fs.existsSync(gitDir)) continue;

    const name = entry.name;
    repos[name] = {
      path: repoPath,
      allowedReadPaths: ['.'],
      allowedWritePaths: ['.'],
      deniedPaths: ['.git', '.env', '.env.*', 'node_modules', '__pycache__', 'secrets'],
      allowedTasks: {},
    };
    console.log(`Auto-discovered repo: ${name} at ${repoPath}`);
  }

  return repos;
}

export function loadConfig(): AppConfig {
  const filePath = findConfigPath();
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = YAML.parse(raw) ?? {};

  const reposDir: string | undefined = parsed.reposDir;

  let repos: Record<string, RepoConfig> = parsed.repos ?? {};

  if (reposDir) {
    const resolvedDir = path.resolve(reposDir);
    const discovered = discoverReposInDir(resolvedDir);
    repos = { ...discovered, ...repos };
  }

  if (!repos || Object.keys(repos).length === 0) {
    throw new Error('Config must define at least one repo under repos or reposDir.');
  }

  const config: AppConfig = {
    server: {
      ...DEFAULT_CONFIG.server,
      ...(parsed.server ?? {}),
      mcpPath: ensureMcpPath(parsed.server?.mcpPath),
    },
    security: {
      ...DEFAULT_CONFIG.security,
      ...(parsed.security ?? {}),
      globalDeniedPaths: [
        ...DEFAULT_CONFIG.security.globalDeniedPaths,
        ...((parsed.security?.globalDeniedPaths ?? []) as string[]),
      ],
    },
    auth: {
      ...DEFAULT_CONFIG.auth,
      ...(parsed.auth ?? {}),
    },
    repos,
    reposDir,
  };

  return config;
}

export function getRepos(config: AppConfig): RepoRuntime[] {
  return Object.entries(config.repos).map(([name, repo]) => ({
    ...repo,
    name,
    absPath: path.resolve(repo.path),
    allowedReadPaths: repo.allowedReadPaths ?? ['.'],
    allowedWritePaths: repo.allowedWritePaths ?? [],
    deniedPaths: repo.deniedPaths ?? [],
    allowedTasks: repo.allowedTasks ?? {},
  }));
}
