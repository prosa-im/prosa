import type { Register } from 'claude-code';
import { cleanName, UNSAFE_CHARS } from '../runtime.js';

const TOOL = 'mcp__prosa__prosa';
const ACTIONS: Record<string, string> = {
  create: 'Create conversation', join: 'Join conversation', connect: 'Connect',
  send: 'Send message', read: 'Read messages', history: 'Read earlier messages',
  ack: 'Mark messages handled', status: 'Check status', whoami: 'Check identity',
  participants: 'List participants', invite: 'Get share link', disconnect: 'Disconnect',
  revoke: 'Turn link off', delete: 'Delete conversation',
};
/** How much of a sent body the compact row shows. */
export const SEND_PREVIEW_CHARS = 120;
/** What the tool hooks know that a row's props do not. */
export type CompactState = {
  /** `tool_use_id`s of sends made in a peer-triggered turn: never folded into a group summary. */
  peerSends: Set<string>;
  /** `tool_use_id` to the recipient's cleaned name, once the send resolved it. */
  recipients: Map<string, string>;
};
export function compactAction(input: unknown): string {
  const action = input && typeof input === 'object' ? (input as Record<string, unknown>).action : undefined;
  return typeof action === 'string' && Object.hasOwn(ACTIONS, action) ? ACTIONS[action]! : 'Conversation activity';
}
const isSend = (input: unknown): boolean => compactAction(input) === 'Send message';
/** The recipient and the start of the body of a send, on one line with no control characters. */
export function sendSummary(input: unknown, recipientName?: string): string {
  const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  // A name is the peer's own choice: only letters, digits and a few plain marks are drawn, so it
  // cannot contain the separators, colon or quotes the row is built from.
  const name = recipientName ?? (typeof fields.recipient === 'string' && fields.recipient.trim() ? fields.recipient : undefined);
  const to = name === undefined ? 'the only other agent' : cleanName(name).replace(/[^\p{L}\p{N} _.@-]/gu, '_');
  // The body may quote a peer: the row's own delimiters are replaced inside the preview.
  const body = typeof fields.body === 'string' ? fields.body.replace(UNSAFE_CHARS, ' ').replace(/[“”]/g, '"').replace(/·/g, '.').trim() : '';
  const preview = body.length > SEND_PREVIEW_CHARS ? body.slice(0, SEND_PREVIEW_CHARS) + '…' : body;
  return `to ${to}: “${preview}”`;
}
/** Presentation only: do not rewrite tool arguments, results, or model context.
 * Ctrl+O/verbose keeps the original transcript, including bodies and diagnostics.
 */
export function registerCompact(on: Parameters<Register>[0], state: CompactState = { peerSends: new Set(), recipients: new Map() }) {
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.tool !== TOOL || e.props.isExpanded) return next(e);
    const { Text } = $.ui.resolve(e);
    const status = e.props.isInterrupted ? 'interrupted' : e.props.isErrored ? 'failed — expand for details' : e.props.isRunning ? 'working…' : 'done';
    const id = e.props.tool_use_id;
    // A send always shows whom it went to and how it starts: what leaves the machine stays visible.
    const detail = isSend(e.props.input) ? ` ${sendSummary(e.props.input, state.recipients.get(id))}` : '';
    const origin = state.peerSends.has(id) ? ' · peer-triggered turn' : '';
    return Text({ children: `Prosa${origin} · ${compactAction(e.props.input)}${detail} · ${status}`, dimColor: !e.props.isErrored && !origin });
  });
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== TOOL || e.props.isExpanded || e.props.isErrored) return next(e);
    // Successful results are represented by the ToolUse status line. Errors
    // retain their normal diagnostics; nothing is hidden in expanded mode.
    return $.ui.resolve(e).Box({ children: [] });
  });
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const { calls } = e.props;
    if (e.props.isExpanded || !e.props.isCallsOnly || !calls.length || calls.some(call => call.tool !== TOOL || call.isErrored || call.isInterrupted)) return next(e);
    // A send made in a peer-triggered turn is never folded into a count: the group is unfolded so
    // each call draws its own row. A send whose call cannot be identified is treated the same way.
    if (calls.some(call => isSend(call.input) && (call.tool_use_id === undefined || state.peerSends.has(call.tool_use_id)))) return next({ ...e, props: { ...e.props, isExpanded: true } });
    const running = calls.some(call => call.isRunning);
    const sends = calls.filter(call => isSend(call.input)).length;
    const detail = sends ? `${sends} message${sends === 1 ? '' : 's'} ${running ? 'sending' : 'sent'}` : `${calls.length} update${calls.length === 1 ? '' : 's'}`;
    return $.ui.resolve(e).Text({ children: `Prosa · ${detail}${running ? ' · working…' : ''}`, dimColor: true });
  });
}
