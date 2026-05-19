/**
 * Gzip via the Web Streams API. Available in Node 18+ and Cloudflare
 * Workers, so the same helper works in both the CLI's filesystem
 * checks and the audit Worker's live checks. Avoids divergence
 * between source-side and live measurements of bundle size.
 */
export async function gzipByteLength(input: Uint8Array): Promise<number> {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
  const compressed = readable.pipeThrough(new CompressionStream('gzip'));
  const reader = compressed.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) total += value.byteLength;
  }
  return total;
}
