// One uniformly random article from each evenly spaced stratum, across each file.
const FRACTION = 0.30;
const BATCH_SIZE = 128;
function sampleSegments(segments, random = Math.random) {
  const seen = new Set();
  const ordered = segments.slice().sort((a, b) => a.number - b.number)
    .filter(s => s.id && !seen.has(s.id) && seen.add(s.id));
  const count = Math.ceil(ordered.length * FRACTION);
  return Array.from({ length: count }, (_, i) => {
    const lo = Math.floor(i * ordered.length / count);
    const hi = Math.floor((i + 1) * ordered.length / count);
    return ordered[lo + Math.floor(random() * (hi - lo))];
  });
}

// Takes an exclusively leased nntp@0.3.1 socket. Never returns the modified
// parser to the pool: destroy and replace it even on success. This preserves
// the existing pool connection budget and avoids leftover response poisoning.
async function checkSample(pool, segments, timeoutMs = 12000) {
  if (!pool || !segments.length) throw new Error('sample unavailable');
  // Header/archive reads finish verification. Let those queued reads run
  // before starting another long article scan when more releases are active.
  const client = await pool.acquire({ priority: 'sample' });
  if (!client) throw new Error('sample client unavailable');
  const socket = client._socket;
  try {
    if (!socket || socket.destroyed || client._curReq || client._queue?.length) {
      throw new Error('sample client not idle');
    }
    if (segments.some(s => !/^[^\s<>]+@[^\s<>]+$/.test(s.id))) {
      throw new Error('invalid article id');
    }
    socket.removeAllListeners('data');
    return await pipeline(socket, segments.map(s => s.id), timeoutMs);
  } finally {
    if (socket) socket.destroy();
    pool.release(client, { drop: true });
  }
}

function pipeline(socket, ids, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '', sent = 0, checked = 0, missing = 0, settled = false;
    const timer = setTimeout(() => finish(new Error('sample deadline exceeded')), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket.removeListener('data', data);
      socket.removeListener('error', failed);
      socket.removeListener('close', closed);
      if (error) reject(error); else resolve({ planned: ids.length, checked, missing });
    }
    function failed() { finish(new Error('sample connection failed')); }
    function closed() { finish(new Error('sample connection closed')); }
    function send() {
      const batch = ids.slice(sent, sent + BATCH_SIZE);
      sent += batch.length;
      socket.write(batch.map(id => `STAT <${id}>\r\n`).join(''));
    }
    function data(chunk) {
      buffer += chunk.toString('ascii');
      if (buffer.length > 65536) return finish(new Error('sample response too large'));
      let end;
      while (!settled && (end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (checked >= sent) return finish(new Error('unexpected sample response'));
        if (/^223 /.test(line)) {
          if (!line.includes(`<${ids[checked]}>`)) return finish(new Error('sample response identity mismatch'));
        } else if (/^430 /.test(line)) missing += 1;
        else return finish(new Error('sample response not conclusive'));
        checked += 1;
        if (checked === sent) {
          // Drain every response in a sent batch before early rejection.
          if (missing || checked === ids.length) return finish();
          send();
        }
      }
    }
    socket.on('data', data); socket.on('error', failed); socket.on('close', closed);
    send();
  });
}
module.exports = { FRACTION, BATCH_SIZE, sampleSegments, checkSample, pipeline };
