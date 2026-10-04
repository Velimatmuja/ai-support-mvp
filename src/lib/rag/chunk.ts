// Chunking sipas strukturës së tekstit: paragrafë -> fjali -> prerje e fortë.
// ~1200 karaktere (~300 tokena) për chunk: mjaft i vogël që 6 chunks të hyjnë lirshëm
// në prompt (~2k tokena), mjaft i madh që një përgjigje FAQ të mos ndahet në dysh.
export type ChunkOptions = {
  maxChars?: number;
  overlapChars?: number;
};

const SENTENCE_END = /(?<=[.!?…])\s+/;

function splitLong(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];

  const out: string[] = [];
  let current = '';
  for (const sentence of block.split(SENTENCE_END)) {
    if (sentence.length > maxChars) {
      // Fjali pa pikësim (lista çmimesh, tabela): prit te hapësira më e afërt.
      if (current) out.push(current);
      current = '';
      let rest = sentence;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut < maxChars * 0.5) cut = maxChars;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    if (current && current.length + 1 + sentence.length > maxChars) {
      out.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) out.push(current);
  return out;
}

function tail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return '';
  const slice = text.slice(-overlapChars);
  const space = slice.indexOf(' ');
  return space === -1 ? slice : slice.slice(space + 1);
}

export function chunkText(input: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? 1200;
  const overlapChars = options.overlapChars ?? 150;

  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return [];

  // `continues` = kjo pjesë është vazhdim i të njëjtit paragraf (paragrafi u nda në mes).
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .flatMap((b) => splitLong(b, maxChars - overlapChars).map((piece, i) => ({ text: piece, continues: i > 0 })));

  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + 2 + block.text.length > maxChars) {
      chunks.push(current);
      // Mbivendosje VETËM brenda një paragrafi të ndarë: fundi i pjesës së mëparshme
      // i jep kontekst vazhdimit. Midis paragrafëve të ndryshëm (p.sh. dy pyetje të
      // një FAQ) nuk ka mbivendosje: do të përziente tema pa lidhje në të njëjtin chunk.
      const carry = block.continues ? tail(current, overlapChars) : '';
      current = carry ? `${carry} ${block.text}` : block.text;
    } else {
      current = current ? `${current}${block.continues ? ' ' : '\n\n'}${block.text}` : block.text;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
