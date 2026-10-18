import {setTimeout as delay} from 'node:timers/promises';
import {gatewayConfig,privateUrl} from './config.js';
import {GatewayJournal} from './journal.js';
import {GatewayTransport,GatewayError} from './transport.js';
import {GatewayShadowWorker} from './worker.js';
import {HttpJsonAdapter,ConnectorError} from '../adapters.js';

// Preserve the R11 HTTP connector API, with one bounded request per invocation.
// A transport status (including 429) never proves an external effect was not accepted.
export class R11GatewayConnector extends HttpJsonAdapter {
  private readonly origin: string;
  constructor(endpoint: string, capabilities: string[], private readonly r11Token?: string) {
    super('r11',capabilities,privateUrl(endpoint),r11Token);
    this.origin = privateUrl(endpoint);
  }
  protected async call(path: string, body?: unknown, signal?: AbortSignal, idempotencyKey?: string) {
      try {
        const res = await fetch(this.origin + path,{method:body === undefined ? 'GET' : 'POST',redirect:'error',
          signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(30000)]),
          headers:{'content-type':'application/json',...(this.r11Token ? {authorization:'Bearer ' + this.r11Token} : {}),
            ...(idempotencyKey ? {'idempotency-key':idempotencyKey} : {})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
        if (!res.ok) throw new Error();
        return await res.json();
      } catch {throw new ConnectorError(body === undefined ? 'CONNECTOR_UNAVAILABLE' : 'SUBMISSION_UNCERTAIN',false);}
  }
}

export async function runGatewayWorker(oneTick: boolean, env = process.env) {
  const config = gatewayConfig(env);
  const endpoint = privateUrl(env.AGY_R11_CONNECTOR_URL);
  let capabilities: unknown;
  try {capabilities = JSON.parse(env.AGY_R11_CAPABILITIES_JSON ?? 'null');}
  catch {throw new GatewayError('R11_CAPABILITIES_REQUIRED');}
  if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(c => typeof c !== 'string' || !c.trim()))
    throw new GatewayError('R11_CAPABILITIES_REQUIRED');
  // Existing private R11 connector contract; no provider discovery or paid adapter construction.
  // No runtime profile asserting safe submission replay is supplied: ambiguous POSTs cannot retry.
  const adapter = new R11GatewayConnector(endpoint,capabilities,env.AGY_R11_CONNECTOR_TOKEN);
  const journal = await GatewayJournal.acquire(config.stateDir,{gateway:config.url,worker:config.workerId,endpoint,capabilities});
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.on('SIGTERM',onStop); process.on('SIGINT',onStop);
  try {
    const worker = new GatewayShadowWorker(new GatewayTransport(config.url,config.workerId,config.timeoutMs),journal,adapter,config);
    do {
      const outcome = await worker.tick(stop.signal);
      console.log(JSON.stringify({transport:'GATEWAY_SHADOW',outcome,canonical_authority:'EXISTING_POSTGRES_D049',production:false}));
      if (oneTick || stop.signal.aborted) break;
      await delay(config.pollMs,undefined,{signal:stop.signal}).catch(() => {});
    } while (!stop.signal.aborted);
  } catch (e) {
    // Do not export remote error bodies, lease tokens or credentials to runtime logs.
    console.error(JSON.stringify({transport:'GATEWAY_SHADOW',outcome:'BLOCKED',
      code:e instanceof GatewayError ? e.code : 'GATEWAY_RUNTIME_FAILED',reconciliation_required:true}));
    process.exitCode = 1;
  } finally {
    stop.abort(); process.off('SIGTERM',onStop); process.off('SIGINT',onStop); await journal.close();
  }
}
