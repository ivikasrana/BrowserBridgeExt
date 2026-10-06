import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PORT } from '../shared/protocol';

export const dataDir = join(homedir(), '.browserbridge');
const tokenPath = join(dataDir, 'token');
let token: string | undefined;

export function getToken(): string {
  if (token) return token;
  if (existsSync(tokenPath)) token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) {
    mkdirSync(dataDir, { recursive: true });
    token = randomBytes(24).toString('hex');
    writeFileSync(tokenPath, token, { mode: 0o600 });
  }
  return token;
}

export const getPort = () => Number(process.env.BROWSERBRIDGE_PORT) || PORT;

/** Diagnostics go to stderr: stdout is the protocol channel in both MCP and native mode. */
export const warn = (...a: unknown[]) => process.stderr.write('[browser-bridge] ' + a.join(' ') + '\n');
