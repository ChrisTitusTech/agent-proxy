
//







//


const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export interface SplitResult {
  reasoning: string;
  content: string;
}


function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

export function splitReasoning(raw: string): SplitResult {
  if (!raw) return { reasoning: '', content: '' };

  const closeCount = countOccurrences(raw, CLOSE_TAG);
  if (closeCount !== 1) {
    return { reasoning: '', content: raw };
  }

  const closeIdx = raw.indexOf(CLOSE_TAG);

  let beforeClose = raw.slice(0, closeIdx);
  const afterClose = raw.slice(closeIdx + CLOSE_TAG.length);


  const openIdx = beforeClose.indexOf(OPEN_TAG);
  if (openIdx !== -1) {
    beforeClose = beforeClose.slice(openIdx + OPEN_TAG.length);
  }

  return {
    reasoning: beforeClose.replace(/^\s+|\s+$/g, ''),
    content: afterClose.replace(/^\s+/, ''),
  };
}

/**
 *
 *   const splitter = new ReasoningSplitter();
 *   for (const delta of stream) {
 *     const { reasoning, content } = splitter.push(delta);
 *     if (reasoning) emitThinking(reasoning);
 *     if (content) emitContent(content);
 *   }
 *   const tail = splitter.flush();
 *
 */
export class ReasoningSplitter {
  private mode: 'thinking' | 'content' = 'thinking';
  private buffer = '';
  private seenAnyToken = false;

  push(delta: string): { reasoning: string; content: string } {
    if (!delta) return { reasoning: '', content: '' };



    if (!this.seenAnyToken) {
      this.seenAnyToken = true;

      if (delta.startsWith(OPEN_TAG)) {
        delta = delta.slice(OPEN_TAG.length);
      }
    }

    this.buffer += delta;

    if (this.mode === 'content') {
      const out = this.buffer;
      this.buffer = '';
      return { reasoning: '', content: out };
    }


    const closeIdx = this.buffer.indexOf(CLOSE_TAG);
    if (closeIdx !== -1) {
      const reasoning = this.buffer.slice(0, closeIdx);
      const trailing = this.buffer.slice(closeIdx + CLOSE_TAG.length);
      this.buffer = '';
      this.mode = 'content';
      return {
        reasoning,
        content: trailing.replace(/^\s+/, ''),
      };
    }


    const safeLen = Math.max(this.buffer.length - (CLOSE_TAG.length - 1), 0);
    if (safeLen === 0) {
      return { reasoning: '', content: '' };
    }
    const safe = this.buffer.slice(0, safeLen);
    this.buffer = this.buffer.slice(safeLen);
    return { reasoning: safe, content: '' };
  }

  flush(): { reasoning: string; content: string } {
    const tail = this.buffer;
    this.buffer = '';
    if (!tail) return { reasoning: '', content: '' };
    return this.mode === 'thinking'
      ? { reasoning: tail, content: '' }
      : { reasoning: '', content: tail };
  }

  get isInThinking(): boolean {
    return this.mode === 'thinking';
  }
}
