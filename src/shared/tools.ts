// Tool schemas are sent to the model on every turn, so every word here costs context.
// Keep descriptions terse and parameters few.

const tab = { type: 'number', description: 'tab id (default: selected tab)' };
const read = { type: 'boolean', description: 'also return read output' };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'tabs',
    description: 'List tabs (> selected, * active) or a=new|select|close|resize. Other tools act on the selected tab.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', enum: ['list', 'new', 'select', 'close', 'resize'] },
        tab,
        url: { type: 'string' },
        w: { type: 'number' },
        h: { type: 'number' },
        all: { type: 'boolean', description: 'all windows' },
      },
    },
  },
  {
    name: 'nav',
    description: 'Go to url, or back|forward|reload. Waits for load.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, read, tab }, required: ['url'] },
  },
  {
    name: 'read',
    description:
      'Page as compact list: interactive elements with refs (e5) + headings. mode: tree (default) | all (adds text) | text (plain text) | find (q: words or css:selector). Paginate with offset.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['tree', 'all', 'text', 'find'] },
        q: { type: 'string' },
        ref: { type: 'string', description: 'only this subtree' },
        max: { type: 'number', description: 'max chars (4000)' },
        offset: { type: 'number' },
        tab,
      },
    },
  },
  {
    name: 'act',
    description:
      'Interact by ref (from read) or x,y (last shot pixels). a: click dblclick rclick hover | type (text; ref focuses first) | key (text e.g. "ctrl+a Backspace Enter") | fill (fields {ref: value|bool}) | scroll (ref, or dx/dy px) | drag (to: ref or "x,y") | upload (files: local paths) | wait (ms, or text to appear).',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'string',
          enum: ['click', 'dblclick', 'rclick', 'hover', 'type', 'key', 'fill', 'scroll', 'drag', 'upload', 'wait'],
        },
        ref: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
        fields: { type: 'object' },
        to: { type: 'string' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        files: { type: 'array', items: { type: 'string' } },
        ms: { type: 'number' },
        read,
        tab,
      },
      required: ['a'],
    },
  },
  {
    name: 'shot',
    description:
      'Screenshot (JPEG). ref or region [x,y,w,h] to zoom; full = whole page; save = file path, returns only the path.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        region: { type: 'array', items: { type: 'number' } },
        full: { type: 'boolean' },
        w: { type: 'number', description: 'max width px (1024)' },
        save: { type: 'string' },
        tab,
      },
    },
  },
  {
    name: 'js',
    description: 'Evaluate JS in the page; returns the last expression (await allowed).',
    inputSchema: { type: 'object', properties: { code: { type: 'string' }, tab }, required: ['code'] },
  },
  {
    name: 'logs',
    description: 'Tab console, errors (JS + failed requests) or network since load.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['console', 'errors', 'network'] },
        q: { type: 'string', description: 'filter' },
        n: { type: 'number', description: 'max lines (30)' },
        all: { type: 'boolean', description: 'network: include static assets' },
        clear: { type: 'boolean' },
        tab,
      },
    },
  },
  {
    name: 'gif',
    description: 'Record agent actions as GIF: a=start, stop, save (path).',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string', enum: ['start', 'stop', 'save'] }, path: { type: 'string' }, tab },
      required: ['a'],
    },
  },
];

/** One-line-per-tool reference for harnesses that call the CLI instead of MCP. */
export function toolsReference(): string {
  return TOOLS.map((t) => {
    const req = new Set(t.inputSchema.required ?? []);
    const params = Object.entries(t.inputSchema.properties)
      .map(([k, v]) => {
        const e = (v as { enum?: string[] }).enum;
        return (req.has(k) ? k : k + '?') + (e ? '=' + e.join('|') : '');
      })
      .join(' ');
    return `${t.name} ${params}\n  ${t.description}`;
  }).join('\n');
}
