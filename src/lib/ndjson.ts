// Splits a byte stream into lines (NDJSON). Incomplete lines are buffered until the next chunk.

export function createLineSplitter(onLine: (line: string) => void) {
  const dec = new TextDecoder();
  let buf = '';
  const drain = () => {
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
  return {
    push(chunk: Uint8Array) { buf += dec.decode(chunk, { stream: true }); drain(); },
    end() { buf += dec.decode(); buf += '\n'; drain(); },
  };
}
