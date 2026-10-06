export const PORT = 47821;
export const HOST_NAME = 'com.browserbridge.ext';
export const GECKO_ID = 'browser-bridge-ext@browserbridge.local';
export const NO_BROWSER = 'NO_BROWSER';

export type Role = 'agent' | 'browser';

export interface ToolResult {
  text?: string;
  image?: { data: string; mime: string };
  /** Binary output the agent side writes to disk (e.g. a GIF). */
  file?: { data: string; ext: string };
}

export type Msg =
  | { t: 'hello'; name: string }
  | { t: 'call'; id: number; tool: string; args: Record<string, unknown>; sid?: string; prefer?: string }
  | { t: 'res'; id: number; ok: true; result: ToolResult }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'ping' }
  | { t: 'pong' }
  /** Native host -> extension: state of the host's link to the hub. */
  | { t: 'link'; up: boolean };
