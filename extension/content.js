(() => {
  'use strict';
  const VERSION = '0.2.3';
  const API = 'https://onlinebooking-api.prod.workforce-planner.dk/';
  const PREFS_KEY = 'ledige-tider:prefs';
  const LOG_KEY = 'ledige-tider:log';
  const LOG_MAX = 2000;
  const CACHE_MS = 2 * 60 * 1000;
  if (document.getElementById('ledige-tider-host')) return;

  // ---------- debug log ----------
  // Kept in memory and in sessionStorage so it survives a page reload in the
  // same tab. Never holds names, CPR numbers, tokens or email addresses: values
  // from the API are reduced to their structure, and all text is scrubbed.
  const scrub = (s) => String(s)
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, '«token»')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '«email»')
    .replace(/\b\d{6}-?\d{4}\b/g, '«cpr»')
    .replace(/[A-Za-z0-9+_=]{40,}/g, '«long»');
  let entries = [];
  try { entries = JSON.parse(sessionStorage.getItem(LOG_KEY)) || []; } catch { /* start empty */ }
  const log = (type, data = {}) => {
    try {
      entries.push(JSON.parse(scrub(JSON.stringify({ t: new Date().toISOString().slice(11, 23), type, ...data }))));
      if (entries.length > LOG_MAX) entries.splice(0, entries.length - LOG_MAX);
      sessionStorage.setItem(LOG_KEY, JSON.stringify(entries));
    } catch { /* logging must never break the tool */ }
  };
  const logError = (where, e) => log('error', { where, message: e?.message, stack: String(e?.stack || '').split('\n').slice(0, 4).join(' | ') });
  // Structure of a value without its contents: keys, types and array lengths.
  const shape = (v, d = 0) => {
    if (v === null) return null;
    if (Array.isArray(v)) return v.length ? [`×${v.length}`, shape(v[0], d + 1)] : [];
    if (typeof v === 'object') { if (d > 4) return '{…}'; const o = {}; for (const k in v) o[k] = shape(v[k], d + 1); return o; }
    if (typeof v === 'string') return /^[0-9a-f-]{36}$/.test(v) ? 'uuid' : `string(${v.length})`;
    return typeof v;
  };
  // Path plus the names (not values) of the query parameters. Done by hand:
  // iterating URLSearchParams threw in Firefox's content script.
  const pathOnly = (u) => {
    const s = String(u), q = s.indexOf('?');
    const names = q < 0 ? '' : '?' + s.slice(q + 1).split('&').map((p) => p.split('=')[0]).filter(Boolean).join('&');
    return (q < 0 ? s : s.slice(0, q)).replace(/^https:\/\/[^/]+/, '') + names;
  };

  // ---------- site access ----------
  const token = () => { try { return JSON.parse(localStorage.getItem('online-booking:auth:token')); } catch { return null; } };
  const tokenMeta = () => {
    const t = token();
    if (!t) return { present: false };
    const ms = t.expiresAt > 1e12 ? t.expiresAt - Date.now() : t.expiresAt * 1000 - Date.now();
    let h = 0; for (const c of String(t.accessToken || '')) h = (h * 31 + c.charCodeAt(0)) | 0;
    return { present: true, id: (h >>> 0).toString(16), keys: Object.keys(t).join(','), ttlSec: Math.round(ms / 1000), isImpersonating: t.isImpersonating, isMitIdCitizenLogin: t.isMitIdCitizenLogin, tokenType: t.tokenType };
  };
  // In Firefox, content.fetch makes the request as the page itself, which is
  // the way that is known to work. Elsewhere plain fetch does the same.
  const pageFetch = (typeof content !== 'undefined' && typeof content.fetch === 'function') ? content.fetch.bind(content) : fetch.bind(window);
  const api = async (path) => {
    const t = token();
    if (!t?.accessToken) { log('api', { path: pathOnly(path), result: 'no token' }); throw new Error('login'); }
    const started = Date.now();
    let r;
    try { r = await pageFetch(API + path, { headers: { Authorization: 'Bearer ' + t.accessToken } }); }
    catch (e) { log('api', { path: pathOnly(path), result: 'network error', message: e?.message, ms: Date.now() - started }); throw new Error('netværksfejl'); }
    if (!r.ok) {
      let body = '';
      try { body = (await r.text()).slice(0, 200); } catch { /* no body */ }
      log('api', { path: pathOnly(path), status: r.status, ms: Date.now() - started, body });
      throw new Error(r.status === 401 ? 'login' : 'HTTP ' + r.status);
    }
    const json = await r.json();
    log('api', { path: pathOnly(path), status: r.status, ms: Date.now() - started });
    return json;
  };
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...kids.flat().filter((x) => x != null && x !== false));
    return e;
  };

  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })();
  const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  const cache = new Map(); // offerId -> { at, slots: [{start, n}], error }
  const state = { open: false, debug: false, loading: false, error: null, processes: [], processId: null, rows: [], progress: null, run: 0, contextKey: '', professional: false };

  // A driving instructor books on behalf of a student. The site then works
  // with a process and a person that only show up in its own API calls
  // (process/{id}/booking-options?impersonatedPersonId={id}), so remember the
  // latest one, and the page to go back to within that student's booking flow.
  let siteProcess = null;
  let optionsRoute = null;
  const OPTIONS_ROUTE = /\/booking-options(\/process\/[0-9a-f-]{36})?$/;
  const impersonating = () => !!token()?.isImpersonating;
  const person = () => (impersonating() && siteProcess?.personId) || null;
  const withPerson = (path) => { const p = person(); return p ? path + (path.includes('?') ? '&' : '?') + 'impersonatedPersonId=' + p : path; };

  // ---------- data ----------
  const personPicker = () => {
    const box = document.querySelector('[aria-label="Vælg person"][role="listbox"], [role="listbox"][aria-label="Vælg person"]');
    const options = box ? [...box.querySelectorAll('[role="option"]')] : [];
    return { options: options.length, selectedIndex: options.findIndex((o) => o.getAttribute('aria-selected') === 'true') };
  };

  async function loadModel() {
    state.loading = true; state.error = null; render();
    try {
      log('open', { path: location.pathname, token: tokenMeta(), personPicker: personPicker() });
      // Only for the debug log: who is logged in and whom they can book for.
      api('auth/user-info').then((u) => { log('user-info', { isBookOnBehalf: u.isBookOnBehalf, isMitIdProfessional: u.isMitIdProfessional, shape: shape(u) }); if (u.isMitIdProfessional && !state.professional) { state.professional = true; render(); } }).catch(() => {});
      api('person/associated-persons').then((p) => log('associated-persons', { count: p.associatedPersons?.length, shape: shape(p) })).catch(() => {});
      const own = await api('processes/applicant-processes');
      log('processes', { count: own.length, names: own.map((p) => p.taskTypeName), shape: shape(own) });
      // When booking on behalf of a student, use the student the site has selected.
      const ctx = impersonating() ? siteProcess : null;
      log('context', { impersonating: impersonating(), siteProcess: siteProcess && { processId: siteProcess.processId, hasPerson: !!siteProcess.personId }, optionsRoute });
      state.processes = ctx ? [{ processId: ctx.processId, taskTypeName: 'Valgt elev' }] : own;
      const key = ctx ? ctx.processId + '|' + ctx.personId : '';
      if (key !== state.contextKey) { cache.clear(); state.contextKey = key; state.processId = null; }
      if (!state.processes.some((p) => p.processId === state.processId)) state.processId = state.processes[0]?.processId ?? null;
      if (state.processId) await loadOptions();
    } catch (e) { state.error = e.message; logError('loadModel', e); }
    state.loading = false; render();
    log('view', { error: state.error, hasProcess: !!state.processId, rows: state.rows.length, professional: state.professional });
    if (!state.error) scan();
  }

  async function loadOptions() {
    const o = await api(withPerson(`process/${state.processId}/booking-options`));
    const cats = new Map(o.onlineCategories.map((c) => [c.onlineCategoryId, c]));
    const offers = new Map(o.onlineOffers.map((x) => [x.onlineOfferId, x]));
    state.rows = [];
    for (const c of o.onlineCategories) {
      for (const id of c.onlineOfferIds) {
        const of = offers.get(id);
        if (!of) continue;
        state.rows.push({
          offerId: id, center: c.name.trim(), area: cats.get(c.parentOnlineCategoryId)?.name ?? 'Øvrige',
          type: of.name, duration: of.defaultDuration, days: of.daysInFuture,
        });
      }
    }
    log('booking-options', {
      categories: o.onlineCategories.length, offers: o.onlineOffers.length, rows: state.rows.length,
      types: all('type'), areas: all('area'), durations: [...new Set(state.rows.map((r) => r.duration))], days: [...new Set(state.rows.map((r) => r.days))],
      offerShape: shape(o.onlineOffers[0] ?? null), categoryShape: shape(o.onlineCategories[0] ?? null),
    });
  }

  const all = (key) => [...new Set(state.rows.map((r) => r[key]))].sort((a, b) => a.localeCompare(b, 'da'));
  const selected = (key, pref) => new Set(prefs[pref] ? prefs[pref].filter((x) => all(key).includes(x)) : all(key));
  const visibleRows = () => { const a = selected('area', 'areas'), t = selected('type', 'types'); return state.rows.filter((r) => a.has(r.area) && t.has(r.type)); };
  const fresh = (id) => { const c = cache.get(id); return c && !c.error && Date.now() - c.at < CACHE_MS; };

  // One request at a time: parallel requests made the API return 500s.
  async function scan() {
    const run = ++state.run;
    const want = visibleRows().filter((r) => !fresh(r.offerId));
    state.progress = want.length ? { done: 0, total: want.length } : null; render();
    if (want.length) log('scan-start', { centers: want.length });
    const started = Date.now();
    for (const r of want) {
      if (run !== state.run || !state.open) { log('scan-aborted', { done: state.progress?.done }); return; }
      try {
        const start = new Date().toISOString(), end = new Date(Date.now() + r.days * 864e5).toISOString();
        const d = await api(withPerson(`time-slots/task-groups-by-non-anonymous-person/${r.offerId}?startDateTime=${start}&endDateTime=${end}&durationInMinutes=${r.duration}&findFirstAvailable=false`));
        const by = new Map();
        for (const s of d.timeSlots) by.set(s.startTime, (by.get(s.startTime) || 0) + 1);
        cache.set(r.offerId, { at: Date.now(), slots: [...by].map(([start, n]) => ({ start, n })) });
        if (by.size) log('slots', { center: r.center, type: r.type, times: by.size, seats: d.timeSlots.length, first: [...by.keys()].sort()[0] });
      } catch (e) {
        if (e.message === 'login') { state.error = 'login'; break; }
        cache.set(r.offerId, { at: Date.now(), error: true, slots: [] });
        log('slots-failed', { center: r.center, message: e.message });
      }
      if (run !== state.run) return;
      state.progress.done++; render();
    }
    if (want.length) log('scan-end', { ms: Date.now() - started, shown: visibleRows().length, times: visibleRows().reduce((n, r) => n + (cache.get(r.offerId)?.slots.length || 0), 0), withSlots: visibleRows().filter((r) => cache.get(r.offerId)?.slots.length).length, failed: visibleRows().filter((r) => cache.get(r.offerId)?.error).length });
    state.progress = null; render();
  }

  // ---------- ui ----------
  const host = h('div', { id: 'ledige-tider-host' });
  const root = host.attachShadow({ mode: 'open' });
  root.append(h('style', {}, `
    :host { all: initial; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; }
    * { box-sizing: border-box; }
    .launch { position: fixed; right: 24px; bottom: 24px; z-index: 2147483000; border: 0; border-radius: 999px; padding: 14px 20px;
      background: #0b5cab; color: #fff; font: 600 15px/1 inherit; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
    .launch:hover { background: #094a8a; }
    .scrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.4); display: flex; justify-content: flex-end; }
    .panel { width: min(720px, 100vw); height: 100%; background: #fff; display: flex; flex-direction: column; box-shadow: -8px 0 32px rgba(0,0,0,.2); }
    header { padding: 20px 24px 12px; display: flex; align-items: flex-start; gap: 12px; border-bottom: 1px solid #e3e6ea; }
    h1 { font-size: 20px; margin: 0 0 4px; } .sub { font-size: 13px; color: #5b6570; }
    .x { margin-left: auto; border: 0; background: none; font-size: 26px; line-height: 1; cursor: pointer; color: #5b6570; padding: 0 4px; }
    .filters { padding: 12px 24px; border-bottom: 1px solid #e3e6ea; background: #f7f8fa; }
    .frow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0; }
    .flabel { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #5b6570; width: 100%; display: flex; gap: 12px; align-items: baseline; }
    .link { border: 0; background: none; padding: 0; color: #0b5cab; font: inherit; font-size: 12px; text-transform: none; letter-spacing: 0; cursor: pointer; text-decoration: underline; }
    .chip { border: 1px solid #c3c9d1; background: #fff; border-radius: 999px; padding: 6px 12px; font: 13px/1.2 inherit; cursor: pointer; color: #1a1a1a; }
    .chip[aria-pressed="true"] { background: #0b5cab; border-color: #0b5cab; color: #fff; }
    .chip .n { font-weight: 700; margin-left: 6px; } .chip .n.zero { font-weight: 400; opacity: .6; }
    select { font: inherit; font-size: 14px; padding: 6px 8px; border-radius: 6px; border: 1px solid #c3c9d1; }
    .status { padding: 10px 24px; font-size: 13px; color: #5b6570; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #e3e6ea; }
    .bar { flex: 1; height: 6px; background: #e3e6ea; border-radius: 3px; overflow: hidden; } .bar i { display: block; height: 100%; background: #0b5cab; transition: width .2s; }
    .body { flex: 1; overflow: auto; padding: 8px 24px 32px; }
    h2 { font-size: 15px; margin: 20px 0 8px; text-transform: capitalize; position: sticky; top: -8px; background: #fff; padding: 8px 0; border-bottom: 2px solid #1a1a1a; }
    .row { display: grid; grid-template-columns: minmax(180px, 1fr) 2fr; gap: 12px; padding: 10px 0; border-bottom: 1px solid #eef0f2; align-items: start; }
    .center { font-weight: 600; font-size: 14px; } .meta { font-size: 12px; color: #5b6570; margin-top: 2px; }
    .times { display: flex; flex-wrap: wrap; gap: 6px; }
    .time { display: inline-block; padding: 6px 10px; border-radius: 6px; background: #e6f0fa; color: #0b3d75; font: 600 14px/1 inherit; text-decoration: none; font-variant-numeric: tabular-nums; }
    .time:hover { background: #0b5cab; color: #fff; } .time small { font-weight: 400; margin-left: 4px; }
    .empty { padding: 40px 0; text-align: center; color: #5b6570; font-size: 15px; }
    .warn { background: #fff4e0; border: 1px solid #f0c36d; border-radius: 6px; padding: 10px 12px; font-size: 13px; margin: 12px 0; }
    footer { padding: 8px 24px; border-top: 1px solid #e3e6ea; font-size: 12px; color: #5b6570; display: flex; gap: 12px; align-items: center; }
    .debug { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 16px 24px; min-height: 0; }
    .debug p { margin: 0; font-size: 13px; color: #5b6570; }
    .debug textarea { flex: 1; min-height: 200px; font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace; border: 1px solid #c3c9d1; border-radius: 6px; padding: 8px; resize: none; white-space: pre; }
    .btn { border: 1px solid #0b5cab; background: #0b5cab; color: #fff; border-radius: 6px; padding: 8px 14px; font: 600 13px/1 inherit; cursor: pointer; }
    .btn.ghost { background: #fff; color: #0b5cab; }
  `));
  const launch = h('button', { class: 'launch', onclick: () => open() }, '📅 Ledige tider på tværs af prøvesteder');
  const mount = h('div');
  root.append(launch, mount);

  // The site redirects to the start page on a full page load of a slot URL,
  // so hand over through its own router instead of following the link.
  // State is null, not an object: Firefox does not let the page read objects
  // created by an extension.
  const routerGo = (p) => { history.pushState(null, '', p); window.dispatchEvent(new PopStateEvent('popstate', { state: null })); };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const visibleBookButtons = () => [...document.querySelectorAll('main button')].filter((b) => b.textContent.trim() === 'Book' && b.offsetParent).length;
  let handingOver = false;
  root.addEventListener('click', async (e) => {
    const a = e.target.closest?.('a.time');
    if (!a || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (handingOver) return;
    handingOver = true;
    const target = a.getAttribute('href');
    try {
      log('handover-start', { from: location.pathname, to: target });
      // Going from one center's slot page straight to another's leaves the old
      // page on screen, so leave via "Mine prøver" first and wait until the
      // site has finished that navigation (it redirects to /appointments/list).
      if (location.pathname.includes('/offers/')) {
        const base = location.pathname.split('/offers/')[0];
        const t = Date.now();
        if (impersonating()) {
          // An instructor must not leave the student's booking flow (going to
          // the student list ends it), so step back to the area page instead
          // and wait for the site to finish, which shows as a new page title.
          const title = document.title;
          routerGo(optionsRoute || base + '/booking-options');
          while (document.title === title && Date.now() - t < 5000) await pause(50);
        } else {
          routerGo(base + '/appointments');
          while (!location.pathname.includes('/appointments/') && Date.now() - t < 5000) await pause(50);
        }
        log('handover-detour', { ms: Date.now() - t, path: location.pathname, title: document.title });
        await pause(250);
      }
      routerGo(target);
      await pause(300);
    } catch (err) { logError('handover', err); }
    finally { handingOver = false; }
    close();
    // Only for the debug log: did the site end up showing the slot page?
    setTimeout(() => log('handover-result', { path: location.pathname, arrived: location.pathname === target, title: document.title, heading: document.querySelector('main h1, main h2')?.textContent.trim().slice(0, 40), bookButtons: visibleBookButtons() }), 4000);
  });

  const fmtDay = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long' });
  const slotUrl = (r, day) => `${location.pathname.split('/microsites/')[0]}/microsites/${token()?.micrositeId}/offers/${r.offerId}/time-slots/${day}`;
  const personName = () => document.querySelector('[aria-label="Vælg person"]')?.textContent.trim() || '';

  function chips(label, key, pref) {
    const options = all(key), sel = selected(key, pref);
    const other = key === 'area' ? ['type', 'types'] : ['area', 'areas'];
    const count = (v) => state.rows.filter((r) => r[key] === v && selected(...other).has(r[other[0]]))
      .reduce((n, r) => n + (cache.get(r.offerId)?.slots.length || 0), 0);
    const set = (vals) => { prefs[pref] = vals; savePrefs(); log('filter', { [pref]: vals }); render(); scan(); };
    return h('div', { class: 'frow' },
      h('div', { class: 'flabel' }, label,
        h('button', { class: 'link', onclick: () => set(null) }, 'Vælg alle'),
        h('button', { class: 'link', onclick: () => set([]) }, 'Fravælg alle')),
      options.map((v) => { const n = count(v); return h('button', {
        class: 'chip', 'aria-pressed': String(sel.has(v)),
        onclick: () => { const s = new Set(sel); s.has(v) ? s.delete(v) : s.add(v); set([...s]); },
      }, v, sel.has(v) && h('span', { class: 'n' + (n ? '' : ' zero') }, String(n))); }));
  }

  function results() {
    const rows = visibleRows();
    const days = new Map(); // day -> [{row, slots}]
    let total = 0, centers = 0, failed = 0;
    for (const r of rows) {
      const c = cache.get(r.offerId);
      if (c?.error) failed++;
      if (!c?.slots.length) continue;
      centers++;
      const perDay = new Map();
      for (const s of c.slots) { const d = s.start.slice(0, 10); (perDay.get(d) || perDay.set(d, []).get(d)).push(s); total++; }
      for (const [d, slots] of perDay) (days.get(d) || days.set(d, []).get(d)).push({ row: r, slots: slots.sort((a, b) => a.start.localeCompare(b.start)) });
    }
    const multiType = selected('type', 'types').size > 1;
    const out = [];
    if (failed) out.push(h('div', { class: 'warn' }, `${failed} prøvested(er) kunne ikke hentes. Tryk Opdater for at prøve igen.`));
    if (!rows.length) out.push(h('div', { class: 'empty' }, 'Vælg mindst ét område og én prøvetype.'));
    else if (!total && !state.progress) out.push(h('div', { class: 'empty' }, `Ingen ledige tider på de ${rows.length} valgte prøvesteder lige nu.`));
    for (const d of [...days.keys()].sort()) {
      out.push(h('h2', {}, fmtDay(d)));
      for (const { row, slots } of days.get(d).sort((a, b) => a.row.center.localeCompare(b.row.center, 'da'))) {
        out.push(h('div', { class: 'row' },
          h('div', {}, h('div', { class: 'center' }, row.center), h('div', { class: 'meta' }, row.area + (multiType ? ' · ' + row.type : ''))),
          h('div', { class: 'times' }, slots.map((s) => h('a', { class: 'time', href: slotUrl(row, d), title: 'Åbn i MinKøreprøve for at booke' },
            s.start.slice(11, 16), s.n > 1 && h('small', {}, '×' + s.n))))));
      }
    }
    return { out, total, centers, scanned: rows.length };
  }

  const logText = () => [`Ledige køreprøvetider ${VERSION}`, navigator.userAgent, `${entries.length} linjer`, '', ...entries.map((e) => JSON.stringify(e))].join('\n');
  function debugView() {
    const area = h('textarea', { readonly: true, spellcheck: 'false' });
    area.value = logText();
    const note = h('span', { style: 'font-size:13px;color:#5b6570' });
    const copy = async () => {
      try { await navigator.clipboard.writeText(area.value); note.textContent = 'Kopieret.'; }
      catch { area.select(); note.textContent = document.execCommand('copy') ? 'Kopieret.' : 'Kunne ikke kopiere. Markér teksten og kopiér selv.'; }
    };
    const save = () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([area.value], { type: 'text/plain' })), download: `ledige-tider-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt` });
      document.body.append(a); a.click(); a.remove();
    };
    return h('div', { class: 'debug' },
      h('p', {}, 'Teknisk log til fejlsøgning. Den viser hvilke kald der blev lavet til MinKøreprøve, og hvordan de gik. Den indeholder interne id\'er og navne på prøvesteder, men ingen personnavne, CPR-numre eller adgangsnøgler.'),
      h('div', { style: 'display:flex;gap:8px;align-items:center' },
        h('button', { class: 'btn', onclick: copy }, 'Kopiér log'),
        h('button', { class: 'btn ghost', onclick: save }, 'Gem som fil'),
        h('button', { class: 'btn ghost', onclick: () => { entries = []; sessionStorage.removeItem(LOG_KEY); render(); } }, 'Ryd'),
        note),
      area);
  }

  function render() { try { renderPanel(); } catch (e) { logError('render', e); } }
  function renderPanel() {
    launch.style.display = state.open ? 'none' : '';
    if (!state.open) { mount.replaceChildren(); return; }
    let body = root.querySelector('.body'); const top = body?.scrollTop || 0;
    const kids = [];
    kids.push(h('header', {},
      h('div', {}, h('h1', {}, 'Ledige prøvetider'), h('div', { class: 'sub' }, [person() ? 'Viser tider for den valgte elev' : personName() && `Viser tider for ${personName()}`, 'Klik på et tidspunkt for at booke det i MinKøreprøve'].filter(Boolean).join(' · '))),
      h('button', { class: 'x', 'aria-label': 'Luk', onclick: close }, '×')));
    if (state.debug) kids.push(debugView());
    else if (state.error === 'login') kids.push(h('div', { class: 'body' }, h('div', { class: 'warn' }, 'Du er ikke logget ind, eller sessionen er udløbet. Log ind med MitID og prøv igen.')));
    else if (state.error) kids.push(h('div', { class: 'body' }, h('div', { class: 'warn' }, 'Kunne ikke hente data: ' + state.error)));
    else if (state.loading) kids.push(h('div', { class: 'body' }, h('div', { class: 'empty' }, 'Henter prøvesteder…')));
    else if (!state.processId) kids.push(h('div', { class: 'body' }, h('div', { class: 'empty' }, state.professional || location.pathname.includes('/assessor-processes')
      ? 'Vælg først en elev i Elevoverblik, så du står på siden "Vælg område". Åbn derefter dette panel igen.'
      : 'Der er ingen prøver, der kan bookes for denne person.')));
    else {
      const res = results();
      kids.push(h('div', { class: 'filters' },
        state.processes.length > 1 && h('div', { class: 'frow' }, h('div', { class: 'flabel' }, 'Forløb'),
          h('select', { onchange: async (e) => { state.processId = e.target.value; log('process-selected', { index: e.target.selectedIndex }); cache.clear(); await loadModel(); } },
            state.processes.map((p) => h('option', { value: p.processId, selected: p.processId === state.processId }, p.taskTypeName)))),
        chips('Prøvetype', 'type', 'types'),
        chips('Område', 'area', 'areas')));
      kids.push(h('div', { class: 'status' },
        state.progress
          ? [`Søger… ${state.progress.done}/${state.progress.total}`, h('div', { class: 'bar' }, h('i', { style: `width:${(100 * state.progress.done) / state.progress.total}%` }))]
          : [h('span', {}, `${res.total} ledige tider på ${res.centers} af ${res.scanned} prøvesteder`),
             h('button', { class: 'link', style: 'margin-left:auto;font-size:13px', onclick: () => { cache.clear(); scan(); } }, 'Opdater')]));
      kids.push(h('div', { class: 'body' }, res.out));
    }
    kids.push(h('footer', {}, `Version ${VERSION}`,
      h('button', { class: 'link', onclick: () => { state.debug = !state.debug; render(); } }, state.debug ? 'Tilbage til tiderne' : 'Fejlsøgning')));
    mount.replaceChildren(h('div', { class: 'scrim', onclick: (e) => { if (e.target.classList.contains('scrim')) close(); } }, h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Ledige prøvetider' }, kids)));
    body = root.querySelector('.body'); if (body) body.scrollTop = top;
  }

  function open() { state.open = true; state.debug = false; loadModel().catch((e) => logError('open', e)); }
  function close() { state.open = false; state.run++; render(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) close(); });

  // ---------- background observations for the debug log ----------
  // What the site itself calls (paths only), where it navigates, and when the
  // login token is replaced, for example after picking another person.
  log('init', {
    version: VERSION, path: location.pathname, fetch: typeof content !== 'undefined' && typeof content.fetch === 'function' ? 'content.fetch' : 'fetch',
    localStorageKeys: Object.keys(localStorage), sessionStorageKeys: Object.keys(sessionStorage).filter((k) => k !== LOG_KEY), token: tokenMeta(),
  });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!/^https:\/\/[^/]*workforce-planner\.dk\//.test(e.name) || /\.(js|css|woff2?|svg|png|ico)(\?|$)/.test(e.name)) continue;
        if (e.initiatorType === 'fetch' && e.name.startsWith(API)) continue;
        log('site-call', { path: pathOnly(e.name), by: e.initiatorType, status: e.responseStatus || undefined, ms: Math.round(e.duration) });
        const m = /\/process\/([0-9a-f-]{36})\/booking-options(?:\?(.*))?$/.exec(e.name);
        if (m && e.initiatorType !== 'fetch') siteProcess = { processId: m[1], personId: (/(?:^|&)impersonatedPersonId=([0-9a-f-]{36})/.exec(m[2] || '') || [])[1] || null };
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { logError('performance-observer', e); }
  let lastPath = location.pathname, lastToken = tokenMeta().id, lastPicker = JSON.stringify(personPicker());
  if (OPTIONS_ROUTE.test(location.pathname)) optionsRoute = location.pathname;
  setInterval(() => {
    try {
      if (OPTIONS_ROUTE.test(location.pathname)) optionsRoute = location.pathname;
      if (location.pathname !== lastPath) { log('route', { from: lastPath, to: location.pathname, title: document.title }); lastPath = location.pathname; }
      const m = tokenMeta();
      if (m.id !== lastToken) { log('token-changed', m); lastToken = m.id; }
      const p = JSON.stringify(personPicker());
      if (p !== lastPicker) { log('person-picker', personPicker()); lastPicker = p; }
    } catch { /* ignore */ }
  }, 1000);
  window.addEventListener('error', (e) => { if (String(e.filename || '').includes('content.js')) log('error', { where: 'window', message: e.message, line: e.lineno }); });

  document.body.append(host);
  render();
})();
