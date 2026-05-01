/**
 * compartment-viz.js — Compartment-flow visualization (self-contained)
 *
 * Renders the four PK compartments (effect-site, V1 central, V2 fast,
 * V3 slow) as boxes with directional flow arrows whose width and
 * direction reflect the instantaneous mass flow (mg/min) between
 * compartments. Activated by the retrospective Analysis screen, which
 * also teleports the chart canvas alongside it so the user can scrub
 * the chart's inspect cursor and watch the compartments scrub in
 * lockstep.
 *
 * Designed to be ripped out cleanly:
 *   - One import + one init call in js/app.js
 *   - One screen block + one CSS group in index.html
 *   - One getter on js/ui/chart/index.js (chart.inspectTime)
 *   - Reads simulation state through the public model API only
 */

import { DRUG_DEFS } from '../util/constants.js';
import { calcEleveldParams } from '../pk/eleveld.js';
import { calcFentanylParams } from '../pk/fentanyl.js';
import { calcKetamineParams } from '../pk/ketamine.js';

const PARAM_CALC = {
  propofol: calcEleveldParams,
  fentanyl: calcFentanylParams,
  ketamine: calcKetamineParams,
};

// Drugs whose concentrations chart in ng/mL rather than μg/mL.
// Mirrors yScale=1000 entries in CHART_DRUG_CONFIG (chart-bridge.js).
const NG_DRUGS = new Set(['fentanyl', 'ketamine']);

const ARROWS = [
  { id: 'in',     a: 'pump', b: 'v1',   bidir: false, dashed: false },
  { id: 'elim',   a: 'v1',   b: 'elim', bidir: false, dashed: false },
  { id: 'v1v2',   a: 'v1',   b: 'v2',   bidir: true,  dashed: false },
  { id: 'v1v3',   a: 'v1',   b: 'v3',   bidir: true,  dashed: false },
  { id: 'v1ce',   a: 'v1',   b: 'ce',   bidir: true,  dashed: true  },
];

// Two layouts — picked at runtime based on host element aspect ratio.
// "wide" suits portrait viewports (panel below the chart, wide+short).
// "tall" suits landscape viewports (panel right of the chart, narrow+tall).
// `infusion` anchor is the position for the "Infusion" caption — sits just
// outside V1's left edge (text-anchor: end) so it never overlaps the box.
const LAYOUTS = {
  wide: {
    viewBox: '0 0 820 440',
    infusion: { x: 305, y: 250, anchor: 'end' },
    boxes: {
      ce:   { x: 30,  y: 30,  w: 220, h: 110, label: 'Effect site' },
      v1:   { x: 310, y: 165, w: 220, h: 120, label: 'V1 (central)' },
      v2:   { x: 590, y: 60,  w: 220, h: 120, label: 'V2 (fast)' },
      v3:   { x: 310, y: 320, w: 220, h: 110, label: 'V3 (slow)' },
      elim: { x: 590, y: 320, w: 220, h: 90,  label: 'Eliminated' },
    },
    anchors: {
      pump_to_v1: { from: { x: 230, y: 225 }, to: { x: 310, y: 225 } },
      v1_to_elim: { from: { x: 530, y: 260 }, to: { x: 590, y: 365 } },
      v1_to_v2:   { from: { x: 530, y: 180 }, to: { x: 590, y: 130 } },
      v1_to_v3:   { from: { x: 420, y: 285 }, to: { x: 420, y: 320 } },
      v1_to_ce:   { from: { x: 320, y: 165 }, to: { x: 250, y: 105 } },
    },
  },
  tall: {
    viewBox: '0 0 500 940',
    infusion: { x: 105, y: 525, anchor: 'end' },
    boxes: {
      ce:   { x: 20,  y: 40,  w: 220, h: 150, label: 'Effect site' },
      v2:   { x: 260, y: 40,  w: 220, h: 170, label: 'V2 (fast)' },
      v1:   { x: 110, y: 380, w: 280, h: 200, label: 'V1 (central)' },
      v3:   { x: 20,  y: 740, w: 220, h: 180, label: 'V3 (slow)' },
      elim: { x: 260, y: 740, w: 220, h: 180, label: 'Eliminated' },
    },
    anchors: {
      pump_to_v1: { from: { x: 70,  y: 480 }, to: { x: 110, y: 480 } },
      v1_to_elim: { from: { x: 380, y: 580 }, to: { x: 380, y: 740 } },
      v1_to_v2:   { from: { x: 350, y: 380 }, to: { x: 380, y: 210 } },
      v1_to_v3:   { from: { x: 200, y: 580 }, to: { x: 200, y: 740 } },
      v1_to_ce:   { from: { x: 165, y: 380 }, to: { x: 140, y: 190 } },
    },
  },
};

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function fmtFlow(mgPerMin, drugId) {
  const ng = NG_DRUGS.has(drugId);
  const v = Math.abs(mgPerMin);
  const x = ng ? v * 1000 : v;
  const unit = ng ? ' μg/min' : ' mg/min';
  if (x < 0.0001) return '0' + unit;
  if (x < 0.01)   return x.toFixed(4) + unit;
  if (x < 1)      return x.toFixed(3) + unit;
  if (x < 10)     return x.toFixed(2) + unit;
  if (x < 1000)   return x.toFixed(1) + unit;
  // Switch to mg/min for very large flows in ng-drugs (e.g. ketamine bolus delivery)
  if (ng) return v.toFixed(1) + ' mg/min';
  return x.toFixed(0) + unit;
}

function fmtConc(c, drugId) {
  if (!isFinite(c)) return '—';
  if (NG_DRUGS.has(drugId)) return (c * 1000).toFixed(2) + ' ng/mL';
  return c.toFixed(2) + ' μg/mL';
}

function fmtAmount(mg, drugId) {
  if (!isFinite(mg)) return '—';
  const ng = NG_DRUGS.has(drugId);
  if (ng) {
    const ug = mg * 1000;
    if (ug < 1000) return ug.toFixed(1) + ' μg';
    return mg.toFixed(2) + ' mg';
  }
  if (mg < 1) return (mg * 1000).toFixed(1) + ' μg';
  if (mg < 10) return mg.toFixed(2) + ' mg';
  return mg.toFixed(1) + ' mg';
}

export function initCompartmentViz({ getModel, getSelectedDrug, getInspectTime }) {
  const svg = document.getElementById('cv-svg');
  if (!svg) {
    return { setActive() {}, onFrame() {}, destroy() {} };
  }

  const titleEl = document.getElementById('cv-drug-title');
  const timeEl  = document.getElementById('cv-time-label');

  let isActive = false;
  let lastDrugId = null;
  let lastPatientKey = null;
  let cachedParams = null;
  let activeLayoutName = null;
  let layout = LAYOUTS.wide;

  const boxNodes = {};
  const arrowNodes = {};

  pickLayout();
  observeHostResize();

  function pickLayout() {
    const host = svg.parentElement;
    const r = host ? host.getBoundingClientRect() : { width: 1, height: 1 };
    const aspect = (r.width || 1) / (r.height || 1);
    const want = aspect < 1 ? 'tall' : 'wide';
    if (want !== activeLayoutName) {
      activeLayoutName = want;
      layout = LAYOUTS[want];
      buildSvg();
      lastDrugId = null;
    }
  }

  function observeHostResize() {
    const host = svg.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => pickLayout());
    ro.observe(host);
  }

  function buildSvg() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', layout.viewBox);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    for (const arr of ARROWS) {
      const g = svgEl('g', { class: 'cv-arrow cv-arrow-' + arr.id });
      const line = svgEl('line', {
        x1: 0, y1: 0, x2: 0, y2: 0,
        class: 'cv-line' + (arr.dashed ? ' cv-line-dashed' : ''),
      });
      const head = svgEl('polygon', {
        points: '0,0 0,0 0,0',
        class: 'cv-head cv-head-' + arr.id,
      });
      const label = svgEl('text', {
        x: 0, y: 0, class: 'cv-flow-label',
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
      });
      g.appendChild(line);
      g.appendChild(head);
      g.appendChild(label);
      svg.appendChild(g);
      arrowNodes[arr.id] = { g, line, head, label, def: arr };
    }

    for (const key in layout.boxes) {
      const b = layout.boxes[key];
      const g = svgEl('g', { class: 'cv-box cv-box-' + key });
      const rect = svgEl('rect', {
        x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, ry: 8,
        class: 'cv-rect' + (key === 'ce' ? ' cv-rect-virtual' : '')
                        + (key === 'elim' ? ' cv-rect-sink' : ''),
      });
      const title = svgEl('text', {
        x: b.x + b.w / 2, y: b.y + 22,
        class: 'cv-box-title', 'text-anchor': 'middle',
      });
      title.textContent = b.label;
      const volText = svgEl('text', {
        x: b.x + b.w / 2, y: b.y + 42,
        class: 'cv-box-vol', 'text-anchor': 'middle',
      });
      const concText = svgEl('text', {
        x: b.x + b.w / 2, y: b.y + b.h - 28,
        class: 'cv-box-conc', 'text-anchor': 'middle',
      });
      const amtText = svgEl('text', {
        x: b.x + b.w / 2, y: b.y + b.h - 10,
        class: 'cv-box-amt', 'text-anchor': 'middle',
      });
      g.appendChild(rect);
      g.appendChild(title);
      g.appendChild(volText);
      g.appendChild(concText);
      g.appendChild(amtText);
      svg.appendChild(g);
      boxNodes[key] = { g, rect, title, volText, concText, amtText };
    }

    if (layout.infusion) {
      const inf = svgEl('text', {
        x: layout.infusion.x, y: layout.infusion.y,
        class: 'cv-flow-label cv-infusion-label',
        'text-anchor': layout.infusion.anchor || 'middle',
      });
      inf.textContent = 'Infusion';
      svg.appendChild(inf);
    }
  }

  function ensureParams(drugId, model) {
    const patient = model.getPatient ? model.getPatient() : null;
    if (!patient) return null;
    const key = drugId + '|' + patient.weight + '|' + patient.height
              + '|' + patient.age + '|' + patient.male;
    if (drugId === lastDrugId && key === lastPatientKey && cachedParams) {
      return cachedParams;
    }
    const calc = PARAM_CALC[drugId];
    if (!calc) return null;
    cachedParams = calc(patient);
    lastDrugId = drugId;
    lastPatientKey = key;
    applyDrugStyling(drugId, cachedParams);
    return cachedParams;
  }

  function applyDrugStyling(drugId, params) {
    const color = (DRUG_DEFS[drugId] && DRUG_DEFS[drugId].color) || '#0099ff';
    svg.style.setProperty('--cv-drug-color', color);
    if (titleEl) titleEl.textContent = (DRUG_DEFS[drugId] && DRUG_DEFS[drugId].name) || drugId;
    boxNodes.v1.volText.textContent = `V = ${params.V1.toFixed(1)} L`;
    boxNodes.v2.volText.textContent = `V = ${params.V2.toFixed(1)} L`;
    boxNodes.v3.volText.textContent = `V = ${params.V3.toFixed(1)} L`;
    boxNodes.ce.volText.textContent = `ke0 = ${params.ke0.toFixed(3)} /min`;
    boxNodes.elim.volText.textContent = `CL = ${params.CL.toFixed(2)} L/min`;
  }

  function updateArrow(id, signedRate, drugId) {
    const a = arrowNodes[id];
    if (!a) return;
    const arr = a.def;
    const anchorKey = arr.a + '_to_' + arr.b;
    const anchor = layout.anchors[anchorKey];
    if (!anchor) return;
    let { from, to } = anchor;
    const flowing = signedRate < 0;
    if (arr.bidir && flowing) {
      const tmp = from; from = to; to = tmp;
    }
    a.line.setAttribute('x1', from.x);
    a.line.setAttribute('y1', from.y);
    a.line.setAttribute('x2', to.x);
    a.line.setAttribute('y2', to.y);
    a.line.setAttribute('stroke-width', '2.5');
    a.line.setAttribute('stroke-opacity', '1');

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const HEAD_LEN = 11;
    const HEAD_WID = 8;
    const tipX  = to.x;
    const tipY  = to.y;
    const baseX = tipX - ux * HEAD_LEN;
    const baseY = tipY - uy * HEAD_LEN;
    const px = -uy * HEAD_WID / 2;
    const py =  ux * HEAD_WID / 2;
    a.head.setAttribute('points',
      `${tipX.toFixed(1)},${tipY.toFixed(1)} ` +
      `${(baseX + px).toFixed(1)},${(baseY + py).toFixed(1)} ` +
      `${(baseX - px).toFixed(1)},${(baseY - py).toFixed(1)}`);

    // Push label off the line along the perpendicular, biased "up" (smaller
    // y in SVG screen coords) so labels never sit on top of the stroke.
    let nx = -uy;
    let ny = ux;
    if (ny > 0) { nx = -nx; ny = -ny; }
    const offset = 20;
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    a.label.setAttribute('x', mx + nx * offset);
    a.label.setAttribute('y', my + ny * offset);
    a.label.textContent = fmtFlow(signedRate, drugId);
  }

  function onFrame(tLive) {
    if (!isActive) return;
    const model = getModel && getModel();
    const drug  = getSelectedDrug && getSelectedDrug();
    if (!model || !drug) return;

    const inspect = getInspectTime ? getInspectTime() : null;
    const t = (inspect != null && isFinite(inspect)) ? inspect : tLive;

    const params = ensureParams(drug, model);
    if (!params) return;

    let conc;
    try {
      conc = model.getConcentrationsAt(drug, Math.max(0, t));
    } catch (_) {
      return;
    }
    const Cp = conc.Cp || 0;
    const Ce = conc.Ce || 0;
    const C2 = conc.C2 || 0;
    const C3 = conc.C3 || 0;
    const rate = conc.rate || 0;

    const A1 = Cp * params.V1;
    const A2 = C2 * params.V2;
    const A3 = C3 * params.V3;

    boxNodes.v1.concText.textContent = `Cp = ${fmtConc(Cp, drug)}`;
    boxNodes.v1.amtText.textContent  = fmtAmount(A1, drug);
    boxNodes.v2.concText.textContent = `C₂ = ${fmtConc(C2, drug)}`;
    boxNodes.v2.amtText.textContent  = fmtAmount(A2, drug);
    boxNodes.v3.concText.textContent = `C₃ = ${fmtConc(C3, drug)}`;
    boxNodes.v3.amtText.textContent  = fmtAmount(A3, drug);
    boxNodes.ce.concText.textContent = `Ce = ${fmtConc(Ce, drug)}`;
    boxNodes.ce.amtText.textContent  = '';
    boxNodes.elim.concText.textContent = '';
    boxNodes.elim.amtText.textContent  = '';

    const fIn   = Math.max(0, rate);
    const fElim = params.CL * Cp;
    const f12   = params.Q2 * (Cp - C2);
    const f13   = params.Q3 * (Cp - C3);
    const fCe   = params.ke0 * (Cp - Ce);

    updateArrow('in',   fIn,   drug);
    updateArrow('elim', fElim, drug);
    updateArrow('v1v2', f12,   drug);
    updateArrow('v1v3', f13,   drug);
    updateArrow('v1ce', fCe,   drug);

    if (timeEl) {
      const stamp = (m) => {
        const mins = Math.max(0, m);
        const hh = Math.floor(mins / 60);
        const mm = Math.floor(mins % 60);
        const ss = Math.floor((mins * 60) % 60);
        return (hh > 0 ? hh + ':' + String(mm).padStart(2, '0') : mm)
             + ':' + String(ss).padStart(2, '0');
      };
      const liveStamp    = stamp(tLive);
      const scrubStamp   = (inspect != null && isFinite(inspect)) ? stamp(inspect) : '—';
      const showingLabel = (inspect != null && isFinite(inspect)) ? 'scrubbed' : 'live';
      timeEl.textContent = `live ${liveStamp} · scrub ${scrubStamp} · showing ${showingLabel}`;
    }
  }

  function setActive(active) {
    isActive = !!active;
    if (isActive) {
      pickLayout();
      lastDrugId = null;
    }
  }

  function destroy() {
    isActive = false;
  }

  return { setActive, onFrame, destroy };
}
