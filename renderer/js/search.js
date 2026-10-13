// Library search: words, "exact phrases", -exclusions, synonyms, small typos and your own fields.
//   gun             also finds rifle, pistol, gunshot… (listed after the exact matches)
//   "gun"           exact only: quotes turn synonyms and typo tolerance off for that word
//   explsion        finds nothing, so close spellings that do exist are tried (explosion)
//   rating:4+  rating:3  rating:2-  rating:0      by your star rating (0 = not rated)
//   has:note  has:marker  has:rating               sounds you've added something to
// Pure functions, no DOM: tools/test.js checks them directly.

// Built-in sound-design synonyms. Each group is searched as one: any word finds the others.
// Words match at the start of a word in names and descriptions ("car" doesn't find "scar").
export const SYNONYMS = [
  ['gun', 'gunshot', 'rifle', 'pistol', 'handgun', 'shotgun', 'firearm', 'revolver'],
  ['car', 'vehicle', 'auto', 'sedan', 'automobile'],
  ['truck', 'lorry', 'pickup'],
  ['motorcycle', 'motorbike', 'dirtbike'],
  ['plane', 'airplane', 'aeroplane', 'aircraft', 'jet', 'airliner'],
  ['helicopter', 'chopper', 'heli'],
  ['boat', 'ship', 'vessel', 'ferry'],
  ['train', 'railway', 'locomotive', 'subway', 'tram'],
  ['explosion', 'explode', 'blast', 'detonation', 'boom', 'kaboom'],
  ['fire', 'flame', 'blaze', 'burning', 'campfire'],
  ['punch', 'hit', 'impact', 'smack', 'thump', 'strike'],
  ['whoosh', 'swoosh', 'swish', 'woosh', 'swipe', 'passby'],
  ['footstep', 'footsteps', 'step', 'steps', 'walk', 'walking', 'foley feet'],
  ['run', 'running', 'jog', 'sprint'],
  ['door', 'doors', 'doorway'],
  ['glass', 'window', 'shatter', 'smash'],
  ['metal', 'metallic', 'steel', 'iron', 'clank', 'clang'],
  ['wood', 'wooden', 'timber', 'creak'],
  ['water', 'liquid', 'splash', 'drip', 'pour'],
  ['river', 'stream', 'creek', 'brook'],
  ['ocean', 'sea', 'waves', 'surf', 'shore', 'beach'],
  ['rain', 'drizzle', 'downpour', 'shower'],
  ['thunder', 'storm', 'thunderstorm', 'lightning'],
  ['wind', 'gust', 'breeze', 'gale', 'howl'],
  ['ambience', 'ambiance', 'atmos', 'atmosphere', 'background', 'roomtone', 'room tone', 'bed'],
  ['crowd', 'walla', 'people', 'audience'],
  ['applause', 'clapping', 'claps', 'cheer', 'cheering'],
  ['voice', 'vocal', 'speech', 'dialogue', 'talking', 'speaking'],
  ['scream', 'shout', 'yell', 'shriek'],
  ['laugh', 'laughter', 'giggle', 'chuckle'],
  ['breath', 'breathing', 'inhale', 'exhale', 'sigh'],
  ['dog', 'bark', 'puppy', 'hound'],
  ['cat', 'meow', 'kitten', 'purr'],
  ['bird', 'birds', 'birdsong', 'chirp', 'tweet', 'songbird'],
  ['horse', 'gallop', 'neigh', 'hooves'],
  ['insect', 'bug', 'cricket', 'cicada', 'bee', 'mosquito'],
  ['ui', 'interface', 'menu', 'button', 'notification', 'beep'],
  ['click', 'tick', 'tap'],
  ['alarm', 'siren', 'warning', 'alert'],
  ['bell', 'chime', 'ding', 'gong'],
  ['phone', 'telephone', 'ringtone', 'cellphone'],
  ['computer', 'keyboard', 'typing', 'mouse click'],
  ['sci-fi', 'scifi', 'futuristic', 'laser', 'spaceship'],
  ['magic', 'spell', 'sparkle', 'shimmer', 'fairy'],
  ['horror', 'creepy', 'scary', 'eerie', 'spooky'],
  ['monster', 'creature', 'beast', 'growl', 'roar'],
  ['sword', 'blade', 'knife', 'slash', 'stab'],
  ['debris', 'rubble', 'crumble', 'collapse'],
  ['riser', 'rise', 'build', 'buildup', 'tension'],
  ['drone', 'pad', 'hum', 'buzz'],
  ['cloth', 'clothing', 'fabric', 'rustle'],
  ['paper', 'page', 'crumple', 'tear'],
  ['kitchen', 'cooking', 'cutlery', 'dishes', 'plates'],
  ['city', 'urban', 'street', 'traffic', 'downtown'],
  ['forest', 'woods', 'jungle', 'woodland'],
  ['night', 'nighttime', 'evening'],
  ['office', 'workplace', 'cubicle'],
  ['engine', 'motor', 'idle', 'rev'],
  ['tire', 'tyre', 'skid', 'screech'],
  ['crash', 'collision', 'wreck'],
  ['zipper', 'zip'],
  ['camera', 'shutter'],
  ['heartbeat', 'heart', 'pulse'],
];

// "gun = rifle, pistol" lines from Settings → extra synonym groups.
export function parseUserSynonyms(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const words = line.toLowerCase().split(/[=,;]/).map(w => w.trim()).filter(Boolean);
    if (words.length > 1) out.push(words);
  }
  return out;
}

// Splits a search into words, phrases, exclusions and field filters.
export function parseSearch(q) {
  const out = { terms: [], exc: [], rating: null, has: new Set() };
  for (const m of String(q || '').toLowerCase().match(/-?"[^"]*"?|\S+/g) || []) {
    const neg = m.startsWith('-') && m.length > 1;
    const body = neg ? m.slice(1) : m;
    const quoted = body.startsWith('"');
    const text = body.replace(/^"|"$/g, '').trim();
    if (!text) continue;
    if (!quoted && !neg) {
      const r = /^(?:rating|stars?):(\d)([+-]?)$/.exec(text);
      if (r) { const n = Math.min(5, Number(r[1])); out.rating = r[2] === '+' ? [n, 5] : r[2] === '-' ? [0, n] : [n, n]; continue; }
      const h = /^has:(notes?|markers?|ratings?)$/.exec(text);
      if (h) { out.has.add(h[1].replace(/s$/, '')); continue; }
    }
    if (neg) out.exc.push(text);
    else out.terms.push({ text, quoted });
  }
  return out;
}

// One of the words, at the start of a word in the text ("car" in "car pass" or "red_car", not "scar").
function atWordStart(hay, words) {
  for (const w of words) {
    for (let i = hay.indexOf(w); i >= 0; i = hay.indexOf(w, i + 1)) {
      const c = i ? hay.charCodeAt(i - 1) : 32;
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return true;
    }
  }
  return false;
}

// Edit distance (with swapped neighbours counting as one), giving up past `max`.
export function closeness(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

export class Searcher {
  // vocab(): every word in the library (a Set), built only when a typo needs looking up.
  constructor({ groups = SYNONYMS, vocab = () => new Set(), typos = true } = {}) {
    this.vocab = vocab;
    this.typos = typos;
    this.setGroups(groups);
  }

  setTypos(on) { this.typos = !!on; this.cache = new Map(); }

  setGroups(groups) {
    this.byWord = new Map();
    for (const g of groups) for (const w of g) {
      if (!this.byWord.has(w)) this.byWord.set(w, new Set());
      for (const o of g) if (o !== w) this.byWord.get(w).add(o);
    }
    this.cache = new Map();
  }

  vocabChanged() { this.cache.clear(); this.words = null; }

  // Other words that count for `text`: synonyms, or (when nothing in the library contains it)
  // existing words a typo or two away. Returns { alts, re } or null.
  expand(text, typos = false) {
    const ck = (typos ? '~' : '') + text;
    if (this.cache.has(ck)) return this.cache.get(ck);
    const alts = new Set();
    const singular = text.length > 3 && text.endsWith('s') ? text.slice(0, -1) : null;
    for (const w of [text, singular, text + 's']) for (const o of this.byWord.get(w) || []) alts.add(o);
    if (typos && this.typos && text.length >= 4 && /^[a-z]+$/.test(text)) {
      if (!this.words) this.words = [...this.vocab()];
      if (!this.words.some(w => w.includes(text))) {
        const max = text.length >= 8 ? 2 : 1;
        const near = [];
        for (const w of this.words) {
          if (Math.abs(w.length - text.length) > max) continue;
          const d = closeness(text, w, max);
          if (d <= max) near.push([d, w]);
        }
        near.sort((a, b) => a[0] - b[0]);
        for (const [, w] of near.slice(0, 8)) alts.add(w);
      }
    }
    // Words containing the search word add nothing: those sounds already match it exactly.
    for (const a of alts) if (a.includes(text)) alts.delete(a);
    const r = alts.size ? { alts: [...alts] } : null;
    this.cache.set(ck, r);
    return r;
  }

  // A matcher for a parsed search: (hay) => 0 no match, 1 matched through synonyms / typos, 2 exact.
  // typos: also accept close spellings of words nothing contains (worth it only when a search
  // found nothing, since it needs the library's word list).
  matcher(parsed, typos = false) {
    const terms = parsed.terms.map(t => ({ text: t.text, x: t.quoted ? null : this.expand(t.text, typos) }));
    const exc = parsed.exc;
    return hay => {
      let rank = 2;
      for (const t of terms) {
        if (hay.includes(t.text)) continue;
        if (t.x && atWordStart(hay, t.x.alts)) { rank = 1; continue; }
        return 0;
      }
      for (const e of exc) if (hay.includes(e)) return 0;
      return rank;
    };
  }
}

// Every word (letters only, 3+ long) in a list of searchable texts.
export function vocabulary(texts) {
  const out = new Set();
  for (const t of texts) for (const w of t.match(/[a-z]{3,}/g) || []) out.add(w);
  return out;
}
