export const managerProjectionSource = `
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINES = 100_000;
const input = process.argv[1];
const target = process.argv[2];
let bytes = 0;
let lines = 0;
let remainder = '';
const messages = { sendPromptObserved: false, listPeersCalls: 0, messagePeerCalls: 0 };
const evidence = {
  inboundRequests: 0,
  finalReplies: 0,
  firstDeliveryCount: 0,
  secondDeliveryCount: 0,
  firstDelivery: null,
  secondDelivery: null,
  replyCount: 0,
  replyId: null,
};
function processLine(line) {
  if (!line) return;
  if (++lines > MAX_LINES) throw Error('Manager session exceeds projection line cap');
  const entry = JSON.parse(line);
  const selectedId = value => {
    const id = value ?? null;
    if (id !== null && (typeof id !== 'string' || id.length > 256)) throw Error('Manager peer message ID exceeds projection output limit');
    return id;
  };
  const message = entry.message;
  if (message && typeof message === 'object') {
    if (message.role === 'user' && typeof message.content === 'string' && message.content.includes('PEER_E2E_A_SEND')) messages.sendPromptObserved = true;
    if (message.role === 'assistant') for (const part of message.content ?? []) {
      if (part.type === 'toolCall' && part.name === 'list_peers') messages.listPeersCalls++;
      if (part.type === 'toolCall' && part.name === 'message_peer') messages.messagePeerCalls++;
    }
  }
  if (entry.type !== 'custom_message' || entry.customType !== 'pi-herdsman-peer_message') return;
  const text = JSON.stringify(entry);
  if (text.includes('PEER_E2E_REQUEST:') || text.includes('PEER_E2E_REQUEST_SECOND:')) evidence.inboundRequests++;
  if (text.includes('PEER_E2E_REPLY_FINAL')) {
    evidence.finalReplies++;
    evidence.replyCount++;
    if (evidence.replyId === null) evidence.replyId = selectedId(entry.details?.id);
  }
  if (entry.details?.toSessionId !== target) return;
  if (text.includes('PEER_E2E_REQUEST:')) {
    evidence.firstDeliveryCount++;
    if (evidence.firstDelivery === null) evidence.firstDelivery = { id: selectedId(entry.details?.id), file: text.includes('PEER_E2E_MANAGER_FILE_CONTENT_V1') };
  }
  if (text.includes('PEER_E2E_REQUEST_SECOND:')) {
    evidence.secondDeliveryCount++;
    if (evidence.secondDelivery === null) evidence.secondDelivery = { id: selectedId(entry.details?.id) };
  }
}
try {
  const stream = fs.createReadStream(input, { highWaterMark: 64 * 1024 });
  const decoder = new StringDecoder('utf8');
  stream.on('data', chunk => {
    try {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) return stream.destroy(Error('Manager session exceeds projection byte cap'));
      remainder += decoder.write(chunk);
      let newline;
      while ((newline = remainder.indexOf('\\n')) !== -1) {
        const line = remainder.slice(0, newline);
        remainder = remainder.slice(newline + 1);
        processLine(line);
      }
      if (Buffer.byteLength(remainder) > MAX_BYTES) stream.destroy(Error('Manager session line exceeds projection byte cap'));
    } catch (error) {
      stream.destroy(error);
    }
  });
  stream.on('end', () => {
    try {
      remainder += decoder.end();
      processLine(remainder);
      process.stdout.write(JSON.stringify({ ...messages, ...evidence }));
    } catch (error) {
      process.stderr.write(error.message);
      process.exitCode = 1;
    }
  });
  stream.on('error', error => { process.stderr.write(error.message); process.exitCode = 1; });
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}
`;
