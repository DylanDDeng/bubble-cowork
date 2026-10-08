// Local stand-in for the DeepSeek Messages API (Anthropic wire shape) that
// dsh-llm-deepseek speaks since 0.1.7: POST /v1/messages streams SSE, and
// /v1/files backs image uploads. Probes and tests use it with
// DEEPSEEK_BASE_URL=http://127.0.0.1:<port>; nothing here talks to the network.

/**
 * Write one streamed assistant turn: optional thinking, text and tool_use
 * blocks. `thinking` and `text` may be arrays of pieces sent as separate
 * deltas, `pieceDelayMs` spaces them out, and `dropAfterTextPieces` cuts the
 * connection mid-answer to exercise a failed attempt.
 */
async function writeMessagesStream(res, {
  model,
  id = 'msg_aegis_mock',
  thinking,
  text,
  toolCalls = [],
  usage = { input_tokens: 0, output_tokens: 0 },
  pieceDelayMs = 0,
  dropAfterTextPieces,
}) {
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const pieces = (value) => (value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value]);
  const pause = () => (pieceDelayMs > 0 ? new Promise((resolve) => setTimeout(resolve, pieceDelayMs)) : undefined);
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' });
  const { output_tokens: outputTokens = 0, ...startUsage } = usage;
  send('message_start', {
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { ...startUsage, output_tokens: 0 },
    },
  });
  let index = 0;
  if (pieces(thinking).length > 0) {
    send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    for (const piece of pieces(thinking)) {
      send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: piece } });
      await pause();
    }
    send('content_block_stop', { index });
    index += 1;
  }
  if (pieces(text).length > 0) {
    send('content_block_start', { index, content_block: { type: 'text', text: '' } });
    let sent = 0;
    for (const piece of pieces(text)) {
      send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
      sent += 1;
      if (sent === dropAfterTextPieces) {
        // Let the delivered piece reach the client before the connection drops.
        await new Promise((resolve) => setTimeout(resolve, 150));
        res.socket.destroy();
        return;
      }
      await pause();
    }
    send('content_block_stop', { index });
    index += 1;
  }
  for (const call of toolCalls) {
    send('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
    send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input ?? {}) } });
    send('content_block_stop', { index });
    index += 1;
  }
  send('message_delta', {
    delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  send('message_stop', {});
  res.end();
}

/** Text of one block list (string content or text blocks). */
function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block?.type === 'text' ? block.text : '')).join('');
}

/** Top-level system prompt plus any in-history system updates. */
function systemText(body) {
  const updates = (body.messages ?? []).filter((message) => message.role === 'system');
  return [blockText(body.system), ...updates.map((message) => blockText(message.content))].filter(Boolean).join('\n\n');
}

/** Advertised tool names. */
function toolNames(body) {
  return (body.tools ?? []).map((tool) => tool.name).filter(Boolean);
}

/** Every tool_result block in the request, with its text and raw content. */
function toolResults(body) {
  return (body.messages ?? [])
    .filter((message) => message.role === 'user' && Array.isArray(message.content))
    .flatMap((message) => message.content.filter((block) => block.type === 'tool_result'))
    .map((block) => ({ toolUseId: block.tool_use_id, text: blockText(block.content), block }));
}

/** Every assistant content block in the request history. */
function assistantBlocks(body) {
  return (body.messages ?? [])
    .filter((message) => message.role === 'assistant' && Array.isArray(message.content))
    .flatMap((message) => message.content);
}

/** Every image block anywhere in the request (user turns and tool results). */
function imageBlocks(body) {
  const collect = (content) => (Array.isArray(content) ? content.flatMap((block) => (
    block.type === 'image' ? [block] : block.type === 'tool_result' ? collect(block.content) : []
  )) : []);
  return (body.messages ?? []).flatMap((message) => collect(message.content));
}

/** Requested reasoning effort ('off' when thinking is disabled). */
function reasoningEffort(body) {
  return body.thinking?.type === 'disabled' ? 'off' : body.output_config?.effort;
}

/**
 * Serve /v1/files for a request whose raw body is `bytes`. Returns false for
 * other paths. Uploaded multipart bodies are kept whole in `store` so tests
 * can look up a file id and inspect what was sent.
 */
function handleFilesRequest(req, res, bytes, store) {
  const url = new URL(req.url, 'http://mock.local');
  if (!url.pathname.startsWith('/v1/files')) return false;
  const json = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const id = decodeURIComponent(url.pathname.slice('/v1/files/'.length));
  if (req.method === 'POST' && url.pathname === '/v1/files') {
    const fileId = `file-aegis-${store.size + 1}`;
    const filename = /filename="([^"]+)"/.exec(bytes.toString('latin1'))?.[1] ?? 'upload.bin';
    const mimeType = /Content-Type: ([^\r\n]+)/i.exec(bytes.toString('latin1'))?.[1] ?? 'application/octet-stream';
    const file = {
      id: fileId, type: 'file', filename, mime_type: mimeType, size_bytes: bytes.length,
      created_at: new Date().toISOString(), downloadable: false,
    };
    store.set(fileId, { file, bytes });
    json(200, file);
  } else if (req.method === 'GET' && url.pathname === '/v1/files') {
    const data = [...store.values()].map((entry) => entry.file);
    json(200, { data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: false });
  } else if (req.method === 'GET' && store.has(id)) {
    json(200, store.get(id).file);
  } else if (req.method === 'DELETE' && store.has(id)) {
    store.delete(id);
    json(200, { id, type: 'file_deleted' });
  } else {
    json(404, { type: 'error', error: { type: 'not_found_error', message: `unknown file ${id}` } });
  }
  return true;
}

module.exports = {
  writeMessagesStream, blockText, systemText, toolNames, toolResults,
  assistantBlocks, imageBlocks, reasoningEffort, handleFilesRequest,
};
