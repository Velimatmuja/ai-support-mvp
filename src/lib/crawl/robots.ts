// robots.txt sipas RFC 9309: grupi më specifik i User-agent fiton; brenda grupit
// fiton rregulli me rrugën më të gjatë që përputhet; në barazim fiton Allow.
// Ky është respekt ndaj pronarit të site-it, JO kontroll sigurie (ai është te netguard).

type Rule = { allow: boolean; path: string; re: RegExp };

export type Robots = {
  isAllowed: (url: string) => boolean;
  crawlDelayMs: number | null;
  sitemaps: string[];
};

function toRegExp(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

// Krahasimi bëhet me rrugë të koduar njësoj nga të dy anët.
function normPath(p: string): string {
  try {
    return encodeURI(decodeURI(p));
  } catch {
    return p;
  }
}

export function parseRobots(text: string, agent: string): Robots {
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/).slice(0, 5000)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();

    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // "Disallow:" bosh = lejo gjithçka (nuk shtohet rregull).
      if (!value) continue;
      const path = normPath(value.startsWith('/') || value.startsWith('*') ? value : `/${value}`);
      current.rules.push({ allow: key === 'allow', path, re: toRegExp(path) });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n * 1000;
    }
  }

  const token = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== null);

  return {
    sitemaps,
    crawlDelayMs: delays.length ? Math.max(...delays) : null,
    isAllowed(url: string): boolean {
      let path: string;
      try {
        const u = new URL(url);
        path = normPath(`${u.pathname}${u.search}`);
      } catch {
        return false;
      }
      if (path === '/robots.txt') return true;
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.re.test(path)) continue;
        const len = rule.path.replace(/\*|\$$/g, '').length;
        const bestLen = best ? best.path.replace(/\*|\$$/g, '').length : -1;
        if (len > bestLen || (len === bestLen && rule.allow && !best!.allow)) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}
