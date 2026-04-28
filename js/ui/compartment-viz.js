/**
 * compartment-viz.js — Compartment-flow visualization (self-contained)
 *
 * Renders the four PK compartments (effect-site, V1 central, V2 fast,
 * V3 slow) as boxes with directional flow arrows whose width and
 * direction reflect the instantaneous mass flow (mg/min) between
 * compartments. Linked to the chart's inspect cursor when active —
 * scrubbing the chart scrubs the compartment view.
 *
 * Designed to be ripped out cleanly:
 *   - One import + one init call in js/app.js
 *   - One modal block + one button + ~25 lines of CSS in index.html
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

const VIEW_W = 600;
const VIEW_H = 420;

const BOXES = {
  ce:   { x: 30,  y: 30,  w: 140, h: 80,  label: 'Effect site' },
  v1:   { x: 230, y: 160, w: 140, h: 100, label: 'V1 (central)' },
  v2:   { x: 430, y: 60,  w: 140, h: 90,  label: 'V2 (fast)' },
  v3:   { x: 230, y: 320, w: 140, h: 80,  label: 'V3 (slow)' },
  elim: { x: 430, y: 320, w: 140, h: 60,  label: 'Eliminated' },
};

const ARROWS = [
  { id: 'in',     a: 'pump', b: 'v1',   bidir: false, dashed: false },
  { id: 'elim',   a: 'v1',   b: 'elim', bidir: false, dashed: false },
  { id: 'v1v2',   a: 'v1',   b: 'v2',   bidir: true,  dashed: false },
  { id: 'v1v3',   a: 'v1',   b: 'v3',   bidir: true,  dashed: false },
  { id: 'v1ce',   a: 'v1',   b: 'ce',   bidir: true,  dashed: true  },
];

const ANCHORS = {
  pump_to_v1:  { from: { x: 175, y: 210 }, to: { x: 230, y: 210 } },
  v1_to_elim:  { from: { x: 370, y: 240 }, to: { x: 430, y: 350 } },
  v1_to_v2:    { from: { x: 370, y: 175 }, to: { x: 430, y: 130 } },
  v1_to_v3:    { from: { x: 300, y: 260 }, to: { x: 300, y: 320 } },
  v1_to_ce:    { from: { x: 240, y: 160 }, to: { x: 170, y: 90  } },
};

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function fmtFlow(mgPerMin) {
  const v = Math.abs(mgPerMin);
  if (v < 0.0001) return '0';
  if (v < 0.01)   return v.toFixed(4);
  if (v < 1)      return v.toFixed(3);
  if (v < 10)     return v.toFixed(2);
  return v.toFixed(1);
}

function fmtConc(c, drugId) {
  if (!isFinite(c)) return '—';
  if (drugId === 'fentanyl') return (c * 1000).toFixed(2) + ' ng/mL';
  return c.toFixed(2) + ' μg/mL';
}

function fmtAmount(mg) {
  if (!isFinite(mg)) return '—';
  if (mg < 1) return (mg * 1000).toFixed(1) + ' μg';
  if (mg < 10) return mg.toFixed(2) + ' mg';
  return mg.toFixed(1) + ' mg';
}

export function initCompartmentViz({ getModel, getSelectedDrug, getInspectTime }) {
  const overlay = document.getElementById('modal-compartment-viz');
  const svg = document.getElementById('cv-svg');
  if (!overlay || !svg) {
    return { open() {}, close() {}, onFrame() {}, destroy() {} };
  }

  const titleEl = document.getElementById('cv-drug-title');
  const timeEl  = document.getElementById('cv-time-label');

  let isOpen = false;
  let lastDrugId = null;
  let lastPatientKey = null;
  let cachedParams = null;
  let flowScale = 1;

  const boxNodes = {};
  const arrowNodes = {};

  buildSvg();

  function buildSvg() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const defs = svgEl('defs');
    for (const id of ['ah-default', 'ah-elim', 'ah-ce']) {
      const marker = svgEl('marker', {
        id, viewBox: '0 0 10 10', refX: '9', refY: '5',
        markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
      });
      const poly = svgEl('polygon', { points: '0,0 10,5 0,10' });
      poly.setAttribute('class', 'cv-arrowhead cv-ah-' + id.replace('ah-', ''));
      marker.appendChild(poly);
      defs.appendChild(marker);
    }
    svg.appendChild(defs);

    for (const arr of ARROWS) {
      const g = svgEl('g', { class: 'cv-arrow cv-arrow-' + arr.id });
      const line = svgEl('line', {
        x1: 0, y1: 0, x2: 0, y2: 0,
        class: 'cv-line' + (arr.dashed ? ' cv-line-dashed' : ''),
      });
      const label = svgEl('text', {
        x: 0, y: 0, class: 'cv-flow-label',
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
      });
      g.appendChild(line);
      g.appendChild(label);
      svg.appendChild(g);
      arrowNodes[arr.id] = { g, line, label, def: arr };
    }

    for (const key in BOXES) {
      const b = BOXES[key];
      const g = svgEl('g', { class: 'cv-box cv-box-' + key });
      const rect = svgEl('rect', {
        x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, ry: 8,
        class: 'cv-rect' + (key === 'ce' ? ' cv-rect-virtual' : '')
                        + (key === 'elim' ? ' cv-rect-sink' : ''),
      });
      const title = svgEl('text', {
        x: b.x + b.w / 2, y: b.y + 18,
        class: 'cv-box-title', 'text-anchor': 'middle',
      });
      title.textContent = b.label;
      const volText = svgEl('text', {
        x: b.x + b.w / 2, y: b.y + 36,
        class: 'cv-box-vol', 'text-anchor': 'middle',
      });
      const concText = svgEl('text', {
        x: b.x + b.w / 2, y: b.y + b.h - 22,
        class: 'cv-box-conc', 'text-anchor': 'middle',
      });
      const amtText = svgEl('text', {
        x: b.x + b.w / 2, y: b.y + b.h - 7,
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

    const pumpLabel = svgEl('text', {
      x: 100, y: 215, class: 'cv-box-title', 'text-anchor': 'middle',
    });
    pumpLabel.textContent = 'Infusion';
    svg.appendChild(pumpLabel);
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
    flowScale = Math.max(0.5, params.CL * 5);
  }

  function updateArrow(id, signedRate) {
    const a = arrowNodes[id];
    if (!a) return;
    const arr = a.def;
    const anchorKey = arr.a + '_to_' + arr.b;
    const anchor = ANCHORS[anchorKey];
    if (!anchor) return;
    let { from, to } = anchor;
    const flowing = signedRate < 0;
    if (arr.bidir && flowing) {
      const tmp = from; from = to; to = tmp;
    }
    const mag = Math.abs(signedRate);
    const norm = mag / flowScale;
    const sw = Math.max(0.4, Math.min(8, Math.log10(1 + norm * 9) * 4 + 0.6));
    const op = Math.max(0.18, Math.min(1, 0.25 + norm * 0.85));
    a.line.setAttribute('x1', from.x);
    a.line.setAttribute('y1', from.y);
    a.line.setAttribute('x2', to.x);
    a.line.setAttribute('y2', to.y);
    a.line.setAttribute('stroke-width', sw.toFixed(2));
    a.line.setAttribute('stroke-opacity', op.toFixed(2));
    a.line.setAttribute('marker-end',
      'url(#' + (id === 'elim' ? 'ah-elim' : (id === 'v1ce' ? 'ah-ce' : 'ah-default')) + ')');
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2 - 8;
    a.label.setAttribute('x', mx);
    a.label.setAttribute('y', my);
    a.label.textContent = fmtFlow(signedRate) + ' mg/min';
    a.label.setAttribute('opacity', op.toFixed(2));
  }

  function onFrame(tLive) {
    if (!isOpen) return;
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
    boxNodes.v1.amtText.textContent  = fmtAmount(A1);
    boxNodes.v2.concText.textContent = `C₂ = ${fmtConc(C2, drug)}`;
    boxNodes.v2.amtText.textContent  = fmtAmount(A2);
    boxNodes.v3.concText.textContent = `C₃ = ${fmtConc(C3, drug)}`;
    boxNodes.v3.amtText.textContent  = fmtAmount(A3);
    boxNodes.ce.concText.textContent = `Ce = ${fmtConc(Ce, drug)}`;
    boxNodes.ce.amtText.textContent  = '';
    boxNodes.elim.concText.textContent = '';
    boxNodes.elim.amtText.textContent  = '';

    const fIn   = Math.max(0, rate);
    const fElim = params.CL * Cp;
    const f12   = params.Q2 * (Cp - C2);
    const f13   = params.Q3 * (Cp - C3);
    const fCe   = params.ke0 * (Cp - Ce);

    updateArrow('in',   fIn);
    updateArrow('elim', fElim);
    updateArrow('v1v2', f12);
    updateArrow('v1v3', f13);
    updateArrow('v1ce', fCe);

    if (timeEl) {
      const mins = Math.max(0, t);
      const hh = Math.floor(mins / 60);
      const mm = Math.floor(mins % 60);
      const ss = Math.floor((mins * 60) % 60);
      const stamp = (hh > 0 ? hh + ':' + String(mm).padStart(2, '0') : mm)
                  + ':' + String(ss).padStart(2, '0');
      const label = (inspect != null) ? `Scrubbed t = ${stamp}` : `Live t = ${stamp}`;
      timeEl.textContent = label;
    }
  }

  function open() {
    isOpen = true;
    overlay.classList.add('open');
    lastDrugId = null;
  }

  function close() {
    isOpen = false;
    overlay.classList.remove('open');
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  function destroy() {
    close();
  }

  return { open, close, onFrame, destroy };
}
