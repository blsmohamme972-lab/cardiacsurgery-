/**
 * Shared question lists (docs/ARCHITECTURE.md §7.13), used by the Library,
 * the Question browse screen (prev/next) and Results.
 *
 * A list is addressed by a key:
 * | key                 | questions                                   | order                    |
 * |---------------------|---------------------------------------------|--------------------------|
 * | `bookmarks`         | bookmarked                                  | bank order               |
 * | `notes`             | with a non-blank text note                  | last edited first        |
 * | `voice`             | with a voice note                           | newest recording first   |
 * | `highlights`        | with a highlight                            | newest highlight first   |
 * | `flagged`           | with a "report a problem" entry             | newest report first      |
 * | `mistakes`          | last answer was wrong (`lastCorrect===false`)| most recent mistake first|
 * | `session:<id>`      | the session's questions                     | session order            |
 * | `chapter:<id>`      | the chapter's questions                     | file order               |
 * | `search:<encoded q>`| search results                              | best match first         |
 *
 * Only questions of `data.studyChapters()` are listed (the published
 * chapters, or the demo in demo mode), except that a session or chapter list
 * keeps its own questions (e.g. a demo session after chapters were published).
 *
 * The pure helpers ({@link parseListKey}, {@link listTitle},
 * {@link collectQids}, {@link listHref}, {@link qidNumber}) run in Node;
 * {@link getList} loads data and storage lazily, so importing this module
 * has no side effects. Record lists (bookmarks, notes, …) are built from the
 * index and the learner's records only: no question file is fetched, so a
 * list of thousands stays fast. A listed question that was later removed from
 * its file simply fails to open (screens show "no longer available").
 *
 * @module features/lists
 */

/** Every list kind. */
export const LIST_KINDS = Object.freeze(['bookmarks', 'notes', 'voice', 'highlights', 'flagged', 'session', 'chapter', 'search', 'mistakes']);

/** Kinds whose key carries an argument (`kind:<arg>`). */
const ARG_KINDS = new Set(['session', 'chapter', 'search']);

/** Human titles of the simple kinds. */
const TITLES = Object.freeze({
  bookmarks: 'Bookmarks',
  notes: 'Notes',
  voice: 'Voice notes',
  highlights: 'Highlights',
  flagged: 'Flagged',
  mistakes: 'Mistakes',
  session: 'Quiz',
  chapter: 'Chapter',
  search: 'Search',
});

/** Most search hits a list keeps. */
const SEARCH_LIST_LIMIT = 200;

/**
 * @typedef {{ kind: string, arg: string | null }} ParsedKey
 * @typedef {{ key: string, title: string, qids: string[] }} QuestionList
 * @typedef {{ data: any, repo: any, search?: any }} ListsBackend
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {any[]}
 */
function listOf(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isId(v) {
  return typeof v === 'string' && v !== '';
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Splits a list key into its kind and argument. Pure.
 * `'bookmarks'` → `{kind: 'bookmarks', arg: null}`; `'session:abc'` → `{kind: 'session', arg: 'abc'}`;
 * `'search:mitral%20valve'` → `{kind: 'search', arg: 'mitral valve'}` (decoded).
 * @param {unknown} key
 * @returns {ParsedKey | null} Null for an unknown or malformed key.
 */
export function parseListKey(key) {
  if (typeof key !== 'string' || key === '') return null;
  const i = key.indexOf(':');
  const kind = i === -1 ? key : key.slice(0, i);
  if (!LIST_KINDS.includes(kind)) return null;
  if (!ARG_KINDS.has(kind)) return i === -1 ? { kind, arg: null } : null;
  if (i === -1) return null;
  let arg = key.slice(i + 1);
  if (kind === 'search') {
    try {
      arg = decodeURIComponent(arg);
    } catch {
      /* keep it raw */
    }
    arg = arg.trim();
  }
  return arg === '' ? null : { kind, arg };
}

/**
 * The key of a search-results list. Pure.
 * @param {string} query
 * @returns {string}
 */
export function searchListKey(query) {
  return `search:${encodeURIComponent(String(query ?? '').trim())}`;
}

/**
 * Display title of a list. Pure.
 * @param {string} kind
 * @param {string | null} [arg]
 * @param {string} [name] Session title or chapter title when known.
 * @returns {string}
 */
export function listTitle(kind, arg = null, name) {
  if (kind === 'search') return arg ? `Search: “${arg}”` : TITLES.search;
  if ((kind === 'session' || kind === 'chapter') && typeof name === 'string' && name.trim() !== '') return name.trim();
  return /** @type {Record<string, string>} */ (TITLES)[kind] ?? 'Questions';
}

/**
 * Ids of `records` (by `field`), first occurrence kept, after sorting by
 * `sortKey` descending (stable). Records without a valid id are skipped.
 * @param {any[]} records
 * @param {string | null} sortKey
 * @param {(rec: any) => boolean} [keep]
 * @returns {string[]}
 */
function idsOf(records, sortKey, keep = () => true) {
  const rows = listOf(records).filter((r) => isObj(r) && isId(r.qid) && keep(r));
  if (sortKey) rows.sort((a, b) => num(b[sortKey]) - num(a[sortKey]));
  return [...new Set(rows.map((r) => /** @type {string} */ (r.qid)))];
}

/**
 * The number part of a question id (`"CH03-0012"` → 12; malformed → +Infinity). Pure.
 * @param {unknown} qid
 * @returns {number}
 */
export function qidNumber(qid) {
  const m = typeof qid === 'string' ? /-(\d+)$/.exec(qid) : null;
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/**
 * @typedef {object} StudyScope
 * @property {(qid: string) => boolean} has  True for a question of the study chapters.
 * @property {(qid: string) => number} [rank] Bank position (chapter order, then id number);
 *   used for the bookmarks order. Default: the id's number.
 */

/**
 * @param {string[] | StudyScope | null | undefined} study
 * @returns {Required<StudyScope>}
 */
function scopeOf(study) {
  if (Array.isArray(study)) {
    const order = study.filter(isId);
    const pos = new Map(order.map((q, i) => [q, i]));
    return { has: (q) => pos.has(q), rank: (q) => pos.get(q) ?? Number.POSITIVE_INFINITY };
  }
  if (isObj(study) && typeof study.has === 'function') {
    const has = /** @type {StudyScope} */ (study).has;
    const rank = typeof study.rank === 'function' ? /** @type {(q: string) => number} */ (study.rank) : qidNumber;
    return { has, rank };
  }
  return { has: () => false, rank: qidNumber };
}

/**
 * The question ids of a simple list kind from the learner's records. Pure.
 *
 * @param {string} kind `bookmarks | notes | voice | highlights | flagged | mistakes`.
 * @param {any[]} records The matching store's records (qstate for bookmarks/mistakes,
 *   notes, voice, highlights, reports).
 * @param {string[] | StudyScope} study Which questions may be listed: study-bank ids in
 *   bank order, or a {@link StudyScope} (membership test + bank rank) so the
 *   question files need not be loaded.
 * @returns {string[]}
 */
export function collectQids(kind, records, study) {
  const scope = scopeOf(study);
  /** @type {string[]} */
  let ids;
  switch (kind) {
    case 'bookmarks': {
      ids = idsOf(records, null, (r) => r.bookmarked === true).filter((q) => scope.has(q));
      const rank = new Map(ids.map((q) => [q, scope.rank(q)]));
      // Stable: equal ranks keep record order.
      return ids
        .map((q, i) => ({ q, i, r: /** @type {number} */ (rank.get(q)) }))
        .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r < b.r ? -1 : 1))
        .map((x) => x.q);
    }
    case 'mistakes':
      ids = idsOf(records, 'lastTs', (r) => r.lastCorrect === false);
      break;
    case 'notes':
      ids = idsOf(records, 'updated', (r) => typeof r.text === 'string' && r.text.trim() !== '');
      break;
    case 'voice':
    case 'highlights':
    case 'flagged':
      ids = idsOf(records, 'ts');
      break;
    default:
      return [];
  }
  return ids.filter((q) => scope.has(q));
}

/**
 * A relative link that opens a question in browse mode inside a list
 * (prev/next follow the list). Pure.
 * @param {string} qid
 * @param {string} [key] List key; omitted → no list.
 * @returns {string} e.g. `'#/q/CH03-0001?list=bookmarks'`.
 */
export function listHref(qid, key) {
  const base = `#/q/${encodeURIComponent(String(qid ?? ''))}`;
  return typeof key === 'string' && key !== '' ? `${base}?list=${encodeURIComponent(key)}` : base;
}

// ---------------------------------------------------------------------------
// Loading (lazy imports; test seam)
// ---------------------------------------------------------------------------

/** @type {ListsBackend | null} */
let testBackend = null;

/** @returns {Promise<any>} */
function dataApi() {
  return testBackend ? Promise.resolve(testBackend.data) : import('../core/data.js');
}

/** @returns {Promise<any>} */
function repoApi() {
  return testBackend ? Promise.resolve(testBackend.repo) : import('../core/store/repo.js');
}

/** @returns {Promise<any>} */
function searchApi() {
  return testBackend && testBackend.search ? Promise.resolve(testBackend.search) : import('./search.js');
}

/**
 * The study scope from the index alone (no question file is loaded): a
 * question belongs to the study bank when its id prefix maps to one of
 * `studyChapters()`; its rank is (chapter order, id number).
 * @param {any} data
 * @returns {Promise<Required<StudyScope>>}
 */
async function studyScope(data) {
  const chapters = listOf(await data.studyChapters());
  const order = new Map(chapters.filter(isObj).map((c, i) => [c.id, i]));
  /** @param {string} q */
  const chapterOf = (q) => {
    const id = data.chapterIdFromQid(q);
    return typeof id === 'string' && order.has(id) ? id : null;
  };
  return {
    has: (q) => chapterOf(q) !== null,
    rank: (q) => {
      const c = chapterOf(q);
      const n = qidNumber(q);
      return (c === null ? order.size : /** @type {number} */ (order.get(c))) * 1e9 + (Number.isFinite(n) ? n : 1e9 - 1);
    },
  };
}

/**
 * Loads a question list.
 *
 * @param {string} key See the module table (`'bookmarks'`, `'session:<id>'`, …).
 * @returns {Promise<QuestionList>} An unknown key, a missing session or an
 *   unavailable chapter gives an empty list (never throws for those).
 * @throws {Error} `DataError` / `StorageError` (plain-language message) when loading fails.
 */
export async function getList(key) {
  const parsed = parseListKey(key);
  const k = typeof key === 'string' ? key : '';
  if (!parsed) return { key: k, title: 'Questions', qids: [] };
  const { kind, arg } = parsed;

  if (kind === 'session') {
    const repo = await repoApi();
    const s = await repo.sessionsRepo.get(arg);
    const qids = isObj(s) ? [...new Set(listOf(s.qids).filter(isId))] : [];
    return { key: k, title: listTitle(kind, arg, isObj(s) ? s.title : undefined), qids };
  }

  const data = await dataApi();
  if (kind === 'chapter') {
    const chapter = await data.getChapter(arg);
    if (!chapter) return { key: k, title: listTitle(kind, arg), qids: [] };
    const { questions } = await data.loadChapter(chapter.id);
    const qids = listOf(questions).map((q) => (isObj(q) ? q.id : null)).filter(isId);
    return { key: k, title: listTitle(kind, arg, chapter.title), qids };
  }

  if (kind === 'search') {
    const [search, scope] = await Promise.all([searchApi(), studyScope(data)]);
    const hits = listOf(await search.search(arg, { limit: SEARCH_LIST_LIMIT }));
    const qids = [...new Set(hits.map((r) => (isObj(r) ? r.qid : null)).filter((q) => isId(q) && scope.has(q)))];
    return { key: k, title: listTitle(kind, arg), qids };
  }

  const repo = await repoApi();
  /** @type {Promise<any[]>} */
  let records;
  if (kind === 'bookmarks' || kind === 'mistakes') records = repo.qstateRepo.all();
  else if (kind === 'notes') records = repo.notesRepo.all();
  else if (kind === 'voice') {
    // Reduce to qid + ts at once: no audio stays in memory.
    records = repo.voiceRepo.all().then((list) => listOf(list).map((v) => (isObj(v) ? { qid: v.qid, ts: v.ts } : null)));
  } else if (kind === 'highlights') records = repo.highlightsRepo.all();
  else records = repo.reportsRepo.all();
  const [rows, scope] = await Promise.all([records, studyScope(data)]);
  return { key: k, title: listTitle(kind), qids: collectQids(kind, rows, scope) };
}

/**
 * Unit-test seam: replaces the data/repo (and optional search) modules, or
 * restores the real ones with `null`. Never used by the app.
 * @param {ListsBackend | null} backend
 * @returns {void}
 */
export function setTestBackend(backend) {
  testBackend = isObj(backend) && isObj(backend.data) && isObj(backend.repo) ? /** @type {ListsBackend} */ (backend) : null;
}
