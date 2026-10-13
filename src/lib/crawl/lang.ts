// Identifikim i thjeshtë i gjuhës: atributi lang i faqes ka përparësi; ndryshe numërohen
// fjalë shumë të shpeshta. Mjafton për metadata dhe filtrim, jo për përkthim.
const STOPWORDS: Record<string, string[]> = {
  sq: ['dhe', 'për', 'në', 'një', 'është', 'që', 'me', 'të', 'nga', 'janë', 'ose', 'nuk', 'jemi', 'ju', 'tuaj', 'këtë', 'mund'],
  en: ['the', 'and', 'for', 'with', 'you', 'your', 'are', 'is', 'our', 'this', 'that', 'from', 'we', 'can', 'not', 'have'],
  it: ['il', 'della', 'per', 'con', 'che', 'sono', 'una', 'del', 'non', 'nel', 'gli', 'alla', 'anche', 'questo'],
  de: ['und', 'der', 'die', 'das', 'mit', 'für', 'ist', 'nicht', 'sie', 'wir', 'ein', 'eine', 'auf', 'auch', 'zu'],
  fr: ['les', 'des', 'est', 'pour', 'avec', 'une', 'dans', 'vous', 'nous', 'pas', 'sur', 'aux', 'qui', 'que'],
  es: ['los', 'las', 'para', 'con', 'una', 'por', 'del', 'que', 'está', 'son', 'nuestro', 'también', 'como'],
};

export function detectLanguage(text: string, declared: string | null): string | null {
  if (declared && /^[a-z]{2,3}$/.test(declared)) return declared;
  const words = text.toLowerCase().slice(0, 20_000).split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < 20) return null;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let best: string | null = null;
  let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const score = list.reduce((sum, w) => sum + (counts.get(w) ?? 0), 0);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  // Pak përputhje = e pasigurt: më mirë null se sa gabim.
  return bestScore >= Math.max(3, words.length * 0.03) ? best : null;
}
