import { isAbsolute, relative, resolve, win32 } from 'node:path';

export type HeadlessPolicyDecision = 'ALLOW' | 'DENY' | 'NEEDS_USER_DECISION';

export interface HeadlessPolicyRequest {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Conservative policy for provider approval requests made by a background
 * peer. Unknown requests are denied so an invisible prompt can never block a
 * discussion indefinitely.
 */
export class HeadlessPeerPolicy {
  readonly profile = 'HEADLESS_PEER' as const;
  private readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = resolve(projectPath);
  }

  decide(request: HeadlessPolicyRequest): HeadlessPolicyDecision {
    const method = request.method.toLowerCase();
    const text = JSON.stringify(request.params ?? {}).toLowerCase();
    const command = readText(request.params, ['command', 'cmd', 'shell', 'input']);
    const path = readText(request.params, ['path', 'file', 'cwd', 'workingDirectory']);

    if (this.isDangerous(`${method}\n${text}\n${command ?? ''}`)) return 'DENY';
    if (path && !this.isProjectPath(path)) return 'DENY';
    if (!/approval|permission|authorize|execute|tool/.test(method)) return 'DENY';

    const safe = `${method}\n${command ?? ''}`;
    if (/read|glob|grep|search|lsp|symbol|test|lint|typecheck|build|compile|fetch|web/.test(safe)) {
      return 'ALLOW';
    }
    if (path && this.isProjectPath(path) && /edit|write|create|modify/.test(safe)) return 'ALLOW';
    return 'NEEDS_USER_DECISION';
  }

  private isDangerous(value: string): boolean {
    return /rm\s+(-[rf]+\s+)?["']?(\/|~|%userprofile%|\$home)|git\s+(reset\s+--hard|clean\s+-fdx)|sudo\b|force[- ]push|\b(reg|sc)\s+(add|delete|config)|shutdown\b|credential|password|api[_ -]?key|production\s+database/.test(value);
  }

  private isProjectPath(value: string): boolean {
    if (isWindowsPath(this.projectPath) || isWindowsPath(value)) {
      const projectRoot = win32.resolve(this.projectPath);
      const candidate = win32.resolve(isWindowsPath(value) ? value : win32.join(projectRoot, value));
      const remainder = win32.relative(projectRoot, candidate);
      return remainder === '' || (!remainder.startsWith('..') && !win32.isAbsolute(remainder));
    }
    const candidate = resolve(isAbsolute(value) ? value : resolve(this.projectPath, value));
    const remainder = relative(this.projectPath, candidate);
    return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder));
  }
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function readText(params: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!params) return undefined;
  for (const key of keys) {
    if (typeof params[key] === 'string' && params[key].trim()) return params[key] as string;
  }
  return undefined;
}
