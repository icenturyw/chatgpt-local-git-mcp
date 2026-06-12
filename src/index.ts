import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, getRepos } from './config.js';
import { createMcpServer, REGISTERED_TOOL_NAMES } from './tools.js';
import { UserFacingError } from './security.js';
import { watchReposDir } from './watcher.js';

const config = loadConfig();
const repos = getRepos(config);
const transports: Record<string, StreamableHTTPServerTransport> = {};

function getBearerToken(): string | null {
  const envName = config.auth?.bearerTokenEnv;
  if (!envName) return null;
  const value = process.env[envName];
  return value && value.trim() ? value.trim() : null;
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/.well-known/')) return next();
  const token = getBearerToken();
  if (!token) return next();
  const header = req.header('authorization') ?? '';
  if (header !== `Bearer ${token}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const app = express();
app.use(express.json({ limit: config.server.maxRequestBodyBytes }));
app.use(authMiddleware);

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    name: 'chatgpt-local-git-mcp',
    version: '0.1.0',
    mcpPath: config.server.mcpPath,
    configPath: process.env.CONFIG_PATH || 'config.yaml',
    authRequired: Boolean(getBearerToken()),
    repoCount: repos.length,
    toolCount: REGISTERED_TOOL_NAMES.length,
    tools: [...REGISTERED_TOOL_NAMES],
    repos: repos.map((repo) => ({
      name: repo.name,
      tasks: Object.keys(repo.allowedTasks ?? {}),
    })),
  });
});

// RFC 9728 OAuth Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  res.json({
    resource: `${_req.protocol}://${_req.get('host')}${config.server.mcpPath}`,
    bearer_methods_supported: ['header'],
  });
});

app.post(
  config.server.mcpPath,
  asyncHandler(async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport: StreamableHTTPServerTransport | undefined;

    if (typeof sessionId === 'string' && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string) => {
          transports[newSessionId] = transport!;
        },
        enableJsonResponse: true,
      });

      transport.onclose = () => {
        if (transport?.sessionId) delete transports[transport.sessionId];
      };

      const server = createMcpServer(config, repos);
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: missing or invalid MCP session id',
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  }),
);

async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId !== 'string' || !transports[sessionId]) {
    res.status(400).send('Invalid or missing MCP session id');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

app.get(config.server.mcpPath, asyncHandler(handleSessionRequest));
app.delete(config.server.mcpPath, asyncHandler(handleSessionRequest));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof UserFacingError ? 400 : 500;
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: message });
});

app.listen(config.server.port, config.server.host, () => {
  console.log(`chatgpt-local-git-mcp listening on http://${config.server.host}:${config.server.port}${config.server.mcpPath}`);
  if (config.reposDir) {
    console.log(`Auto-discovering repos from: ${config.reposDir}`);
    watchReposDir(config, repos, (updatedRepos) => {
      console.log(`Repos updated (${updatedRepos.length}): ${updatedRepos.map((r) => r.name).join(', ')}`);
    });
  }
  console.log(`Configured repos (${repos.length}): ${repos.map((repo) => repo.name).join(', ')}`);
  if (!getBearerToken()) {
    console.warn('MCP_AUTH_TOKEN is not set. Use only behind a private tunnel/reverse proxy or in a trusted dev environment.');
  }
});
