export type AllowedTask = {
  description?: string;
  command: string[];
  timeoutMs?: number;
};

export type RepoConfig = {
  path: string;
  defaultBranch?: string;
  allowedReadPaths?: string[];
  allowedWritePaths?: string[];
  deniedPaths?: string[];
  allowedTasks?: Record<string, AllowedTask>;
};

export type AppConfig = {
  server: {
    host: string;
    port: number;
    mcpPath: string;
    maxRequestBodyBytes: number;
  };
  security: {
    requireExpectedShaForOverwrite: boolean;
    maxReadBytes: number;
    maxWriteBytes: number;
    commandTimeoutMs: number;
    globalDeniedPaths: string[];
  };
  auth?: {
    bearerTokenEnv?: string;
  };
  repos: Record<string, RepoConfig>;
  reposDir?: string;
};

export type RepoRuntime = RepoConfig & {
  name: string;
  absPath: string;
};

export type ToolTextResult<T extends Record<string, unknown>> = {
  structuredContent: T;
  content: Array<{ type: 'text'; text: string }>;
};
