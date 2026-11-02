// AGY MCP facade — CANDIDATE, NOT INSTALLED (2026-11-02).
//
// A minimal Model Context Protocol server (streamable HTTP,
// JSON-RPC) that exposes the AGY runtime's EXISTING read/reconcile
// endpoints as MCP tools, so a host (Muse, ChatGPT, another agent)
// can query mission state without the Google Doc mailbox bridge.
// It adds no new authority: every tool is read-only or a dry-run
// report, it holds its own operator identity token (env), and it
// refuses to start without one. Dispatch/submit is intentionally
// NOT a tool here — submissions require an owner-granted window and
// go through the qualification grant protocol, not an MCP call.
//
// Run (after owner consent — see README.md):
//   AGY_SURFACE_URL=https://<runtime-host> \
//   AGY_OPERATOR_TOKEN=<own operator identity token> \
//   PORT=8787 node tools/agy-mcp-facade/server.mjs
import { createServer } from 'node:http';

const SURFACE = process.env.AGY_SURFACE_URL ?? '';
const TOKEN = process.env.AGY_OPERATOR_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 8787);
if (!SURFACE || !TOKEN) {
  console.error('agy-mcp-facade: AGY_SURFACE_URL and AGY_OPERATOR_TOKEN are required; refusing to start.');
  process.exit(2);
}

async function surfaceGet(path) {
  const res = await fetch(`${SURFACE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`surface ${path} -> HTTP ${res.status}`);
  return res.json();
}

const TOOLS = [
  {
    name: 'agy.health',
    description: 'Runtime health of the AGY staging service (READY/production flags). Read-only.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => surfaceGet('/health'),
  },
  {
    name: 'agy.callback_lookup',
    description: 'Look up one worker callback by id: delivery status, effect_count, receipt digest. Read-only.',
    inputSchema: { type: 'object', properties: { callback_id: { type: 'string' } }, required: ['callback_id'] },
    run: async (args) => surfaceGet(`/worker/callbacks/${encodeURIComponent(args.callback_id)}`),
  },
  {
    name: 'agy.callback_reconcile',
    description: 'Dry-run reconciliation report for a task: compares the durable outbox state against receipts and lists any PENDING/unknown callbacks. Changes nothing.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    run: async (args) => surfaceGet(`/worker/callbacks?task_id=${encodeURIComponent(args.task_id)}&reconcile=dry-run`),
  },
  {
    name: 'agy.mission_result',
    description: 'Where a mission result lives. Until a grant-scoped read endpoint is provisioned, results are delivered through the authorized mailbox bridge; this tool returns that pointer instead of inventing a read.',
    inputSchema: { type: 'object', properties: { mission_id: { type: 'string' } }, required: ['mission_id'] },
    run: async (args) => ({
      mission_id: args.mission_id,
      result_destination: 'google-doc-mailbox:1JrDh8ChZdPb137ety4xE3_TwRHTFYOgQPukmxKyeuDE (section 4 RESULT blocks)',
      note: 'No grant-scoped HTTP read endpoint exists yet; the mailbox is the authorized bridge. Do not treat this pointer as the result itself.',
    }),
  },
];

async function handleRpc(msg) {
  if (msg.method === 'initialize') {
    return { protocolVersion: '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'agy-mcp-facade', version: '0.1.0-candidate' } };
  }
  if (msg.method === 'tools/list') {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (msg.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) throw new Error(`unknown tool: ${msg.params?.name}`);
    const out = await tool.run(msg.params?.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }
  if (msg.method === 'ping') return {};
  throw new Error(`unsupported method: ${msg.method}`);
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(404).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  let msg;
  try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
  try {
    const result = await handleRpc(msg);
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }));
  } catch (e) {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: String(e?.message ?? e) } }));
  }
}).listen(PORT, () => console.log(`agy-mcp-facade listening on :${PORT} (candidate, read-only tools)`));
