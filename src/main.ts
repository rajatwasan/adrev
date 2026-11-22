import './styles.css';
import type { CityFile, Options, Priority, Scope, Subject, TradeArea } from './types';
import { WEIGHTS, buildTradeArea, defaultScope, defaultSelection, summarize } from './score';
import { makeSearcher, type Searcher } from './search';
import { AreaMap } from './map';
import { copy, download, targetingList, toCsv } from './export';

const panel = document.getElementById('panel')!;
const legend = document.getElementById('legend')!;
const toastEl = document.getElementById('toast')!;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (n: number) => Math.round(n).toLocaleString('en-US');

let city: CityFile;
let searcher: Searcher;
let map: AreaMap;
let area: TradeArea | null = null;
let selected = new Set<string>();
let hoverId: string | null = null;
const options: Options = { radiusMi: 2, priority: 'balanced', scope: 'same', minConf: 50 };

const RADII = [1, 2, 3, 5];
const PRIORITIES: { id: Priority; label: string; hint: string }[] = [
  { id: 'balanced', label: 'Balanced', hint: 'Reach and open ground weighted about equally' },
  { id: 'reach', label: 'Reach', hint: 'Favor zones with the most addresses' },
  { id: 'gap', label: 'Open ground', hint: 'Favor zones with few competitors per address' },
];

init().catch((err) => {
  console.error(err);
  panel.innerHTML = `<div class="pad"><h1>Adrev could not load its data</h1>
    <p class="muted">The city file did not load. Refresh to try again.</p></div>`;
});

async function init(): Promise<void> {
  panel.innerHTML = `<div class="pad"><div class="brand">Adrev</div><p class="muted">Loading the city…</p></div>`;
  const res = await fetch('./data/city.json');
  if (!res.ok) throw new Error(`city.json ${res.status}`);
  city = await res.json();
  searcher = makeSearcher(city);
  map = new AreaMap(document.getElementById('map')!, city, {
    onZoneClick: toggleZone,
    onMapClick: (lat, lng) => dropPin(lat, lng),
  });
  renderStart();
}

/* ---------- start screen ---------- */

function examples(): number[] {
  const want = ['dental_clinic', 'gym', 'coffee_shop', 'veterinarian', 'hair_salon', 'yoga_studio'];
  const picks: number[] = [];
  for (const id of want) {
    const c = city.cats.findIndex((x) => x.id === id);
    if (c < 0) continue;
    let best = -1;
    for (let p = 0; p < city.places.cat.length; p++) {
      if (city.places.cat[p] !== c || city.places.brand[p] >= 0 || !city.places.addr[p]) continue;
      if (best < 0 || city.places.conf[p] > city.places.conf[best]) best = p;
    }
    if (best >= 0) picks.push(best);
    if (picks.length === 3) break;
  }
  return picks;
}

function renderStart(): void {
  area = null;
  legend.hidden = true;
  map.setPinMode(false);
  void map.showCity();
  const totalReach = city.cells.reach.reduce((s, r) => s + r, 0);
  const unit = city.meta.reachSource === 'addresses' ? 'address points' : 'buildings';
  panel.innerHTML = `
    <div class="pad start">
      <div class="brand">Adrev</div>
      ${city.meta.synthetic ? `<p class="warn">Demo data. This build is running on a synthetic fixture, not the Overture extract.</p>` : ''}
      <h1>Where should your local ad budget go?</h1>
      <p class="lede">Pick a business in ${esc(city.meta.city)}. Adrev ranks the ${zoneWord(2)} around it by how many
      households you can reach, how crowded the competition is, and what draws your customers there already.</p>

      <label class="field-label" for="q">Find your business</label>
      <div class="combo">
        <input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Business name, like “Mission Dental”"
          role="combobox" aria-expanded="false" aria-controls="results" aria-autocomplete="list" />
        <ul id="results" role="listbox" hidden></ul>
      </div>

      <div class="chips" id="examples">
        <span class="muted small">Or try</span>
        ${examples()
          .map(
            (p) =>
              `<button class="chip" data-place="${p}">${esc(city.places.name[p])}<span>${esc(city.cats[city.places.cat[p]].label)}</span></button>`,
          )
          .join('')}
      </div>

      <div class="divider"><span>not open yet?</span></div>
      <label class="field-label" for="pincat">Test a location before you sign the lease</label>
      <div class="pinrow">
        <select id="pincat">
          <option value="">Choose a business type…</option>
          ${catOptions()}
        </select>
        <button id="pinbtn" class="btn" disabled>Drop a pin</button>
      </div>
      <p id="pinhelp" class="muted small" hidden>Now click the map where the business would be.</p>

      <p class="foot muted small">
        ${num(city.places.name.length)} places · ${num(totalReach)} ${unit} · ${city.zones.length} ${zoneWord(city.zones.length)}<br />
        Overture Maps release ${esc(city.meta.release)}
      </p>
    </div>`;

  const q = panel.querySelector<HTMLInputElement>('#q')!;
  const list = panel.querySelector<HTMLUListElement>('#results')!;
  let hits: number[] = [];
  let active = -1;

  const paint = () => {
    list.hidden = hits.length === 0 && q.value.trim().length < 2;
    q.setAttribute('aria-expanded', String(!list.hidden));
    if (list.hidden) return;
    list.innerHTML = hits.length
      ? hits
          .map(
            (p, i) => `<li role="option" id="opt${i}" data-place="${p}" class="${i === active ? 'active' : ''}" aria-selected="${i === active}">
              <strong>${esc(city.places.name[p])}</strong>
              <span>${esc(city.cats[city.places.cat[p]].label)}${city.places.addr[p] ? ' · ' + esc(city.places.addr[p]) : ''}</span></li>`,
          )
          .join('')
      : `<li class="none">No listing by that name. Check the spelling, or drop a pin below.</li>`;
    if (active >= 0) q.setAttribute('aria-activedescendant', `opt${active}`);
    else q.removeAttribute('aria-activedescendant');
  };
  q.addEventListener('input', () => {
    hits = searcher.find(q.value);
    active = hits.length ? 0 : -1;
    paint();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      paint();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choosePlace(hits[active]);
    } else if (e.key === 'Escape') {
      hits = [];
      q.value = '';
      paint();
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-place]');
    if (li) choosePlace(Number(li.dataset.place));
  });
  panel.querySelector('#examples')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-place]');
    if (b) choosePlace(Number(b.dataset.place));
  });

  const pincat = panel.querySelector<HTMLSelectElement>('#pincat')!;
  const pinbtn = panel.querySelector<HTMLButtonElement>('#pinbtn')!;
  const pinhelp = panel.querySelector<HTMLElement>('#pinhelp')!;
  pincat.addEventListener('change', () => {
    pinbtn.disabled = !pincat.value;
    if (!pincat.value) {
      map.setPinMode(false);
      pinhelp.hidden = true;
    }
  });
  pinbtn.addEventListener('click', () => {
    map.setPinMode(true);
    pinhelp.hidden = false;
  });
  q.focus({ preventScroll: true });
}

function catOptions(selectedCat = -1): string {
  const counts = new Map<number, number>();
  for (const c of city.places.cat) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([c, n]) => n >= 20 || c === selectedCat)
    .sort((a, b) => city.cats[a[0]].label.localeCompare(city.cats[b[0]].label))
    .map(([c, n]) => `<option value="${c}"${c === selectedCat ? ' selected' : ''}>${esc(city.cats[c].label)} (${num(n)})</option>`)
    .join('');
}

function zoneWord(n: number): string {
  if (city.meta.zoneKind === 'zip') return n === 1 ? 'ZIP code' : 'ZIP codes';
  return n === 1 ? 'area' : 'areas';
}

/* ---------- choosing a subject ---------- */

function choosePlace(p: number): void {
  start({
    name: city.places.name[p],
    lat: city.places.lat[p],
    lng: city.places.lng[p],
    cat: city.places.cat[p],
    placeIndex: p,
  });
}

function dropPin(lat: number, lng: number): void {
  const sel = panel.querySelector<HTMLSelectElement>('#pincat');
  if (!sel?.value) return;
  const cat = Number(sel.value);
  map.setPinMode(false);
  start({ name: `New ${city.cats[cat].label.toLowerCase()}`, lat, lng, cat, placeIndex: -1 });
}

function start(subject: Subject): void {
  options.scope = defaultScope(city, subject.cat);
  recompute(subject, true, true);
}

function recompute(subject: Subject, reselect: boolean, refit: boolean): void {
  area = buildTradeArea(city, subject, options);
  if (reselect) selected = defaultSelection(area);
  else selected = new Set([...selected].filter((id) => area!.zones.some((z) => z.id === id)));
  hoverId = null;
  renderResult();
  void map.render(area, selected, hoverId, refit);
}

function toggleZone(id: string): void {
  if (!area || !area.zones.some((z) => z.id === id)) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderResult();
  void map.render(area, selected, hoverId, false);
}

/* ---------- result screen ---------- */

function insight(a: TradeArea): string {
  const noun = esc(a.competitorLabel);
  const r = a.options.radiusMi;
  if (a.zones.length === 0)
    return `<p class="insight flat"><strong>Too few addresses within ${r} mi to rank.</strong> Widen the radius.</p>`;
  if (a.competitorIdx.length === 0)
    return `<p class="insight good"><strong>Open field.</strong> No ${noun} listings on record within ${r} mi.</p>`;
  if (!a.saturation) return '';
  const { areaPer10k, cityPer10k, ratio } = a.saturation;
  const rates = `${areaPer10k.toFixed(1)} ${noun} listings per 10,000 addresses here, against ${cityPer10k.toFixed(1)} citywide.`;
  if (ratio >= 1.25)
    return `<p class="insight hot"><strong>Crowded market: ${ratio.toFixed(1)}× the city rate.</strong> ${rates} Spend where the gaps are, not evenly.</p>`;
  if (ratio <= 0.8)
    return `<p class="insight good"><strong>Thin competition: ${ratio.toFixed(1)}× the city rate.</strong> ${rates} Reach matters more than gaps here.</p>`;
  return `<p class="insight flat"><strong>Typical competition for the city.</strong> ${rates}</p>`;
}

function renderResult(): void {
  if (!area) return;
  const a = area;
  const s = a.subject;
  const cat = city.cats[s.cat];
  const sum = summarize(a, selected);
  const w = WEIGHTS[options.priority];
  const scroll = panel.querySelector('.zones')?.scrollTop ?? 0;
  const unit = city.meta.reachSource === 'addresses' ? 'addresses' : 'buildings';
  const addr = s.placeIndex >= 0 ? city.places.addr[s.placeIndex] : 'Dropped pin';
  const parentLabel = cat.parent.replace(/_/g, ' ');
  const broad = cat.id === cat.group; // top level label only, too coarse to count rivals

  panel.innerHTML = `
    <div class="result">
      <header class="pad head">
        <button class="link" id="back">← New search</button>
        <div class="subject">
          <span class="subject-dot"></span>
          <div><h2>${esc(s.name)}</h2><p class="muted small">${esc(cat.label)}${addr ? ' · ' + esc(addr) : ''}</p></div>
        </div>
        <div class="controls">
          <div class="control">
            <span class="field-label">Reach</span>
            <div class="seg" role="group" aria-label="Radius">
              ${RADII.map((r) => `<button data-radius="${r}" class="${r === options.radiusMi ? 'on' : ''}" aria-pressed="${r === options.radiusMi}">${r} mi</button>`).join('')}
            </div>
          </div>
          <div class="control">
            <span class="field-label">Priority</span>
            <div class="seg" role="group" aria-label="Priority">
              ${PRIORITIES.map((p) => `<button data-priority="${p.id}" title="${p.hint}" class="${p.id === options.priority ? 'on' : ''}" aria-pressed="${p.id === options.priority}">${p.label}</button>`).join('')}
            </div>
          </div>
          <div class="control">
            <label class="field-label" for="typesel">Type</label>
            <select id="typesel" class="compact" aria-describedby="typehint">${catOptions(s.cat)}</select>
          </div>
          ${
            broad
              ? `<p id="typehint" class="hint">Overture files this listing under the broad label “${esc(cat.label)}”. Pick its real type above for a meaningful rival count.</p>`
              : ''
          }
          <div class="control">
            <span class="field-label">Rivals</span>
            <div class="seg" role="group" aria-label="Competitor definition">
              <button data-scope="same" title="Only listings filed under ${esc(cat.label)}" class="${options.scope === 'same' ? 'on' : ''}" aria-pressed="${options.scope === 'same'}">${esc(cat.label)}</button>
              ${cat.parent !== cat.id && cat.parent !== cat.group ? `<button data-scope="group" title="Every listing filed under ${esc(parentLabel)}" class="${options.scope === 'group' ? 'on' : ''}" aria-pressed="${options.scope === 'group'}">All ${esc(parentLabel)}</button>` : ''}
            </div>
          </div>
        </div>
        ${insight(a)}
      </header>

      <div class="zones-head pad">
        <h3>${a.zones.length} ${zoneWord(a.zones.length)}, best first</h3>
        <span class="muted small">Tick to target</span>
      </div>
      <ol class="zones">
        ${a.zones
          .map(
            (z, i) => `
          <li class="zone ${selected.has(z.id) ? 'sel' : ''}" data-zone="${esc(z.id)}">
            <label>
              <input type="checkbox" ${selected.has(z.id) ? 'checked' : ''} aria-label="Target ${esc(z.label)}" />
              <span class="rank">${i + 1}</span>
              <span class="zmain">
                <span class="zrow"><strong>${esc(z.label)}</strong><span class="score" title="Score out of 100">${z.score.toFixed(0)}</span></span>
                <span class="bar" aria-hidden="true">
                  <i class="b-reach" style="width:${(w.reach * z.parts.reach * 100).toFixed(1)}%"></i><i class="b-gap" style="width:${(w.gap * z.parts.gap * 100).toFixed(1)}%"></i><i class="b-anchor" style="width:${(w.anchors * z.parts.anchors * 100).toFixed(1)}%"></i><i class="b-prox" style="width:${(w.proximity * z.parts.proximity * 100).toFixed(1)}%"></i>
                </span>
                <span class="why">${esc(z.reason)}</span>
              </span>
            </label>
          </li>`,
          )
          .join('')}
      </ol>

      <details class="pad how">
        <summary>How the score works</summary>
        <p>Each ${zoneWord(1)} gets four parts, scaled 0 to 1 across the ${zoneWord(2)} in range, then weighted:</p>
        <ul>
          <li><i class="key b-reach"></i><strong>Reach ${pct(w.reach)}</strong>: ${unit} inside the radius (Overture ${unit === 'addresses' ? 'addresses' : 'buildings'} theme).</li>
          <li><i class="key b-gap"></i><strong>Open ground ${pct(w.gap)}</strong>: fewer competitors per 1,000 ${unit} scores higher.</li>
          <li><i class="key b-anchor"></i><strong>Anchors ${pct(w.anchors)}</strong>: ${esc(a.anchorLabel)} nearby.</li>
          <li><i class="key b-prox"></i><strong>Proximity ${pct(w.proximity)}</strong>: closer to the business scores higher.</li>
        </ul>
        <p class="muted small">Places with an Overture confidence under ${options.minConf}% are ignored. ${zoneWord(1) === 'ZIP code' ? 'ZIP shapes are approximated from address points on a hexagon grid, so edges are rough.' : ''}
        Address counts are a proxy for households, not a census.</p>
      </details>

      <footer class="pad export">
        <div class="sum">
          <strong>${sum.count} ${zoneWord(sum.count)}</strong> · ${num(sum.reach)} ${unit}
          <span class="muted">(${pct(sum.share)} of range)</span> · ${sum.competitors} competitor${sum.competitors === 1 ? '' : 's'} inside
        </div>
        <div class="btns">
          <button class="btn primary" id="copy" ${sum.count ? '' : 'disabled'}>Copy ${city.meta.zoneKind === 'zip' ? 'ZIP list' : 'pin list'}</button>
          <button class="btn" id="csv" ${a.zones.length ? '' : 'disabled'}>Download CSV</button>
        </div>
        <p class="muted small">Paste the list into location targeting in Meta Ads or Google Ads.</p>
      </footer>
    </div>`;

  const zonesEl = panel.querySelector<HTMLElement>('.zones')!;
  zonesEl.scrollTop = scroll;

  legend.hidden = false;
  legend.innerHTML = `
    <span><i class="lg pin"></i>${esc(s.placeIndex >= 0 ? 'Your business' : 'Your pin')}</span>
    <span><i class="lg comp"></i>Competitors (${a.competitorIdx.length})</span>
    <span><i class="lg anch"></i>Anchors (${a.anchorIdx.length})</span>
    <span><i class="lg sel"></i>Targeted</span>
    <span class="muted">Darker = more ${unit}</span>`;

  panel.querySelector('#back')!.addEventListener('click', renderStart);
  panel.querySelector('.controls')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b || !area) return;
    if (b.dataset.radius) {
      options.radiusMi = Number(b.dataset.radius);
      recompute(area.subject, true, true);
    } else if (b.dataset.priority) {
      options.priority = b.dataset.priority as Priority;
      recompute(area.subject, true, false);
    } else if (b.dataset.scope) {
      options.scope = b.dataset.scope as Scope;
      recompute(area.subject, true, false);
    }
  });
  panel.querySelector<HTMLSelectElement>('#typesel')!.addEventListener('change', (e) => {
    if (!area) return;
    const next = Number((e.target as HTMLSelectElement).value);
    options.scope = defaultScope(city, next);
    recompute({ ...area.subject, cat: next }, true, false);
  });
  zonesEl.addEventListener('change', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-zone]');
    if (li) toggleZone(li.dataset.zone!);
  });
  const setHover = (id: string | null) => {
    if (id === hoverId || !area) return;
    hoverId = id;
    void map.render(area, selected, hoverId, false);
  };
  zonesEl.addEventListener('mouseover', (e) =>
    setHover((e.target as HTMLElement).closest<HTMLElement>('[data-zone]')?.dataset.zone ?? null),
  );
  zonesEl.addEventListener('mouseleave', () => setHover(null));

  panel.querySelector('#copy')!.addEventListener('click', async () => {
    const ok = await copy(targetingList(city, a, selected));
    toast(ok ? `Copied ${sum.count} ${zoneWord(sum.count)} to the clipboard` : 'Copy was blocked. Use Download CSV instead.');
  });
  panel.querySelector('#csv')!.addEventListener('click', () => {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'plan';
    download(`adrev_${slug}.csv`, toCsv(city, a, selected));
    toast('CSV downloaded');
  });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

let toastTimer: number | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2600);
}
