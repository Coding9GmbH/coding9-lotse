// Zerlegt einen Byte-Strom in Zeilen (NDJSON). Unvollständige Zeilen werden bis zum nächsten Stück gepuffert.

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
