import type { Register, EngineInterface, PluginOptions } from 'claude-code';
import { LocalError } from '../runtime.js';

import { registerCompact, type CompactState } from './compact.js';
import { GuestSessions, configuredUrl, TOOL_DESCRIPTION } from '../guest.js';
import { PROSA_TOOL, GATE_FAILED_REASON, PEER_TURN_REASON, UNKNOWN_TURN_REASON, TurnGate, peerTurnTools } from '../gate.js';

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__prosa__prosa': Record<string, unknown>;
  }
}

// The host only lets `$` reach functions declared at the top of this file.
function makeSession($: EngineInterface, options: PluginOptions, gate: TurnGate, sessionId: string): GuestSessions {
  return new GuestSessions({
    sessionId: () => $.session.id(),
    fetch: (url, init) => $.http.fetch(url, init),
    after: (ms, fn) => $.clock.after(ms, fn),
    now: () => $.clock.now(),
    // The gate learns the notice before the host can start its turn.
    submit: text => { gate.ownNotice(text); return $.prompt.submit({ text }); },
    // `prosaUrl` first; a value left in the old `aimUrl` setting is honoured when `prosaUrl` is unset; else the hosted server.
  }, configuredUrl(options.prosaUrl, options.aimUrl), sessionId, {
    trustedOrigins: typeof options.trustedOrigins === 'string' ? [options.trustedOrigins] : Array.isArray(options.trustedOrigins) ? options.trustedOrigins as readonly string[] : [],
    ...(typeof options.maxAutoTurns === 'number' ? { maxAutoTurns: options.maxAutoTurns } : {}),
    // Guest identities survive a reload or restart here: the plugin's own store, a plain JSON file.
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
  });
}

const bound = <K, V>(map: Map<K, V>, key: K, value: V) => { map.set(key, value); if (map.size > 512) map.delete(map.keys().next().value!); };

export const register: Register = (on, options) => {
  const gate = new TurnGate();
  const compact: CompactState = { peerSends: new Set(), recipients: new Map() };
  const mode = peerTurnTools(options.peerTurnTools);
  registerCompact(on, compact);
  let runtime: GuestSessions | undefined;
  let mainTurn: string | undefined;
  const pending = () => runtime?.hasPendingNotice() ?? false;
  on('session.start', async ($, e, next) => {
    // The old runtime is detached first; its leases are released before the new one reads the store.
    const previous = runtime; runtime = undefined; gate.reset();
    await previous?.close();
    runtime = makeSession($, options, gate, await $.session.id());
    await $.tool.register({
      name: 'prosa',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object', properties: {
          action: { type: 'string', enum: ['whoami', 'status', 'create', 'join', 'connect', 'invite', 'participants', 'read', 'history', 'ack', 'send', 'disconnect', 'revoke', 'delete'] },
          threadId: { type: 'string' }, generation: { type: 'string' }, throughSeq: { type: 'integer' }, before: { type: 'integer', minimum: 1 }, title: { type: 'string', maxLength: 200 },
          name: { type: 'string', maxLength: 40 }, question: { type: 'string', maxLength: 32768 }, recipient: { type: 'string' },
          invite: { type: 'string', maxLength: 2048 }, forget: { type: 'boolean' }, body: { type: 'string', maxLength: 32768 }, operationId: { type: 'string', maxLength: 100 },
        }, required: ['action'], additionalProperties: false,
      },
    });
    return next(e);
  });
  on('tool.call', { tool: 'mcp__prosa__prosa' }, async (_$, e) => {
    try {
      if (!runtime) throw new Error('Prosa is inactive; start a fresh session');
      const input = e as unknown as Record<string, unknown>;
      // Whatever `peerTurnTools` says: it only decides about other tools. What prosa itself
      // may do in a peer-triggered turn, and how its sends are shown, does not depend on it.
      const peerTurn = gate.gated(typeof input.agentId === 'string' ? input.agentId : undefined, pending());
      const peerThreadId = peerTurn ? gate.peerThread() : undefined;
      // A turn limited only because it could not be told apart from a queued notice may be the person's own: say so.
      const unknownOrigin = peerTurn && gate.kind() !== 'peer';
      const id = typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined;
      // Recorded before the send: the row is never folded into a summary, whatever the outcome.
      if (peerTurn && input.action === 'send' && id) { compact.peerSends.add(id); if (compact.peerSends.size > 512) compact.peerSends.delete(compact.peerSends.values().next().value!); }
      const result = await runtime.call(input, { peerTurn, ...(peerThreadId ? { peerThreadId } : {}), ...(unknownOrigin ? { unknownOrigin } : {}) }) as Record<string, unknown>;
      const recipient = result?.recipient as { name?: unknown } | undefined;
      if (id && input.action === 'send' && recipient && typeof recipient.name === 'string') bound(compact.recipients, id, recipient.name);
      return { result: JSON.stringify(result) };
    } catch (error) {
      // Only messages written in this plugin are shown; a server's words never are.
      if (error instanceof LocalError) return { isError: true, result: error.message };
      return { isError: true, result: 'Prosa operation failed. Check local configuration, subscription generation/status, invite and authorization. No remote error body is exposed.' };
    }
  });
  // The enforcement: in a peer-triggered turn every tool but prosa is refused by the host's
  // permission decision, whatever the prompt said. The judgment is made before `next`, and the
  // `.catch` refuses unless a fresh judgment says the call is not gated: a failed guard is
  // otherwise skipped by the host, which would let the call through.
  const judge = (e: { tool: string; agentId?: string }): 'pass' | 'gate' => {
    // Asked in every mode, so the turn's state (a latch on a turn of unknown origin) is the same whatever the setting.
    const gated = gate.gated(e.agentId, pending());
    return e.tool === PROSA_TOOL || mode === 'allow' || !gated ? 'pass' : 'gate';
  };
  const reason = () => gate.kind() === 'peer' ? PEER_TURN_REASON : UNKNOWN_TURN_REASON;
  on('tool.check', async ($, e, next) => {
    if (judge(e) === 'pass') return next(e);
    if (mode === 'ask' && e.approver !== undefined) {
      // Never loosen a refusal beneath; an allow or an ask beneath becomes the person's question.
      const beneath = await next(e);
      return beneath.decision === 'deny' ? beneath : { decision: 'ask' as const, reason: reason() };
    }
    return { decision: 'deny' as const, reason: reason() };
  }).catch(($, e, next) => {
    let verdict: 'pass' | 'gate' | 'failed';
    try { verdict = judge(e); } catch { verdict = 'failed'; }
    if (verdict === 'pass') return next(e);
    return { decision: 'deny' as const, reason: verdict === 'failed' ? GATE_FAILED_REASON : reason() };
  });
  on('prompt.submit', async ($, e, next) => {
    // Classify first: if anything below throws, the hook is skipped and the turn stays of unknown origin (gated while a notice is pending).
    const local = gate.submitted(e.origin, e.text);
    if (e.origin.kind === 'composer' && !runtime) runtime = makeSession($, options, gate, await $.session.id());
    if (!local) return next(e);
    // The person typed: the auto-turn budget starts again, no notice is submitted on top of their
    // prompt for one interval, and they are told once about a conversation the budget paused.
    const notes = runtime?.localInput(await $.clock.now()) ?? [];
    const result = await next(notes.length ? { ...e, context: [...(e.context ?? []), ...notes] } : e);
    if (result && result.drop === undefined) gate.entered(result.text);
    return result;
  });
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      // The host may start the next main turn before delivering the previous one's completion:
      // a gated turn replaced this way has ended all the same, and its notice is released.
      const replaced = gate.supersede();
      if (replaced) runtime?.noticeTurnEnded(replaced.threadId);
    }
    gate.turnStart(e.turnId, e.text, e.agentId, pending());
    if (e.agentId === undefined) { mainTurn = e.turnId; runtime?.turn(true); }
    return next(e);
  });
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      // Only this turn's own completion ends its gate. Its notice then stops counting as pending,
      // so the person's later turns are not held to a batch the peer turn left unacknowledged.
      const ended = gate.turnComplete(e.turnId, undefined);
      if (ended) runtime?.noticeTurnEnded(ended.threadId);
      if (e.reason === 'aborted') runtime?.stop();
      runtime?.turn(false);
    }
    return next(e);
  });
  on('turn.abort', ($, e, next) => { if (e.turnId === mainTurn) runtime?.stop(); return next(e); });
  on('session.end', async ($, e, next) => {
    const ending = runtime; runtime = undefined; mainTurn = undefined; gate.reset();
    // Waits for the leases to be released (close never rejects), so the next session reconnects at once.
    await ending?.close();
    return next(e);
  });
};
