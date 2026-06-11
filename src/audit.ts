import fs from 'node:fs';
import path from 'node:path';

export type AuditEvent = {
  time: string;
  tool: string;
  repo: string;
  branch?: string;
  paths?: string[];
  success: boolean;
  error?: string;
};

export function writeAuditLog(repoAbsPath: string, event: AuditEvent): void {
  try {
    const auditDir = path.join(repoAbsPath, '.chatgpt-git-mcp');
    fs.mkdirSync(auditDir, { recursive: true });

    const logFile = path.join(auditDir, 'audit.log');
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (err) {
    console.warn('[audit] Failed to write audit log:', err);
  }
}
