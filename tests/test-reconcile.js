/**
 * test-reconcile.js — Dose reconciliation feature tests
 *
 * Covers:
 *   1. Pure getCumulativeDose math (matches the live extracted helper)
 *   2. Negative-bolus replay: a -mg bolus correctly subtracts AUC so the
 *      final Cp converges toward the no-bolus reality over time.
 *   3. Intermediate-eigenvalue half-life calculation for a 3-compartment
 *      mammillary model (matches js/pk/eigenvalues.js logic).
 */

// ---- Minimal 4x4 engine (matches test-model.js pattern, Cp + C2 + C3 + Ce) ----

const N = 4;
function mat4(){return new Float64Array(16)}
function eye4(){const m=mat4();m[0]=m[5]=m[10]=m[15]=1;return m}
function mul4(A,B){const C=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++){let s=0;for(let k=0;k<N;k++)s+=A[i*N+k]*B[k*N+j];C[i*N+j]=s}return C}
function mulVec4(A,x){const y=new Float64Array(4);for(let i=0;i<N;i++){let s=0;for(let j=0;j<N;j++)s+=A[i*N+j]*x[j];y[i]=s}return y}
function add4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]+B[i];return C}
function sub4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]-B[i];return C}
function scale4(A,s){const B=mat4();for(let i=0;i<16;i++)B[i]=A[i]*s;return B}
function inv4(M){const a=new Float64Array(32);for(let i=0;i<N;i++){for(let j=0;j<N;j++)a[i*8+j]=M[i*N+j];a[i*8+(N+i)]=1}for(let col=0;col<N;col++){let mv=Math.abs(a[col*8+col]),mr=col;for(let r=col+1;r<N;r++){const v=Math.abs(a[r*8+col]);if(v>mv){mv=v;mr=r}}if(mv<1e-15)return null;if(mr!==col)for(let j=0;j<8;j++){const t=a[col*8+j];a[col*8+j]=a[mr*8+j];a[mr*8+j]=t}const p=a[col*8+col];for(let j=0;j<8;j++)a[col*8+j]/=p;for(let r=0;r<N;r++){if(r===col)continue;const f=a[r*8+col];for(let j=0;j<8;j++)a[r*8+j]-=f*a[col*8+j]}}const inv=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++)inv[i*N+j]=a[i*8+(N+j)];return inv}
function expm4(A){const c=[1,1/2,5/44,1/66,1/792,1/15840,1/665280];const nA=(()=>{let mx=0;for(let j=0;j<N;j++){let cs=0;for(let i=0;i<N;i++)cs+=Math.abs(A[i*N+j]);if(cs>mx)mx=cs}return mx})();let s=0;if(nA>0.5){s=Math.ceil(Math.log2(nA/0.5));if(s<0)s=0}const As=(s>0)?scale4(A,1/(1<<s)):A;const As2=mul4(As,As),As3=mul4(As,As2),As4=mul4(As2,As2),As5=mul4(As,As4),As6=mul4(As2,As4);const I=eye4();const powers=[I,As,As2,As3,As4,As5,As6];let Nm=mat4(),Dm=mat4();for(let k=0;k<=6;k++){const sg=(k%2===0)?1:-1;for(let i=0;i<16;i++){Nm[i]+=c[k]*powers[k][i];Dm[i]+=sg*c[k]*powers[k][i]}}const Di=inv4(Dm);if(!Di)return add4(I,A);let result=mul4(Di,Nm);for(let i=0;i<s;i++)result=mul4(result,result);return result}

function createEngine(p){
  const{V1,V2,V3}=p;
  const A=mat4();
  A[0]=-(p.CL+p.Q2+p.Q3)/V1;A[1]=p.Q2/V2;A[2]=p.Q3/V3;
  A[4]=p.Q2/V1;A[5]=-p.Q2/V2;
  A[8]=p.Q3/V1;A[10]=-p.Q3/V3;
  A[12]=p.ke0/V1;A[15]=-p.ke0;
  let st=new Float64Array(4);
  return {
    advance(dt,R){if(dt<=0)return;const e=expm4(scale4(A,dt));const xH=mulVec4(e,st);if(R===0){st=xH;return}const Ai=inv4(A);if(!Ai){st=xH;return}const M=mul4(Ai,sub4(e,eye4()));for(let i=0;i<4;i++)st[i]=xH[i]+M[i*4]*R},
    getConcentrations(){return{Cp:st[0]/V1,C2:st[1]/V2,C3:st[2]/V3,Ce:st[3]}},
    reset(){st=new Float64Array(4)},
  };
}

// Sample propofol-ish 3-compartment params (not Eleveld, just plausible)
const PK = { V1: 6.0, V2: 25.0, V3: 150.0, CL: 1.5, Q2: 1.8, Q3: 0.8, ke0: 0.15 };

// ---- Pure getCumulativeDose (copy of live logic for self-contained test) ----

function getCumulativeDose(events, drugId, now) {
  if (!events || !events.length || !(now > 0)) return { bolusMg: 0, rateMg: 0, totalMg: 0 };
  let bolusMg = 0, rateMg = 0, currentTime = 0, currentRate = 0;
  // Simple test: assume instant bolus delivery (no minimum duration) for math clarity.
  for (const evt of events) {
    if (evt.time > now) break;
    if (evt.time > currentTime) { rateMg += (evt.time - currentTime) * currentRate; currentTime = evt.time; }
    if (evt.type === 'bolus') { bolusMg += evt.value; }
    else if (evt.type === 'rate') currentRate = evt.value;
    else if (evt.type === 'pause') currentRate = 0;
  }
  if (currentTime < now) rateMg += (now - currentTime) * currentRate;
  return { bolusMg, rateMg, totalMg: bolusMg + rateMg };
}

// ---- Cubic solver + intermediate half-life (matches js/pk/eigenvalues.js) ----

function solveCubic(a, b, c, d) {
  // a x^3 + b x^2 + c x + d = 0, returns three real roots (sorted asc)
  // Normalize to depressed cubic: x = y - b/(3a), y^3 + py + q = 0
  const p = (3 * a * c - b * b) / (3 * a * a);
  const q = (2 * b * b * b - 9 * a * b * c + 27 * a * a * d) / (27 * a * a * a);
  const disc = (q * q) / 4 + (p * p * p) / 27;
  const roots = [];
  if (disc > 0) {
    // One real root; for our A matrix all three are real so this branch shouldn't hit
    const u = Math.cbrt(-q / 2 + Math.sqrt(disc));
    const v = Math.cbrt(-q / 2 - Math.sqrt(disc));
    roots.push(u + v);
  } else {
    // Three real roots
    const r = Math.sqrt(-(p * p * p) / 27);
    const phi = Math.acos(Math.max(-1, Math.min(1, -q / (2 * r))));
    const m = 2 * Math.cbrt(r);
    for (let k = 0; k < 3; k++) {
      roots.push(m * Math.cos((phi + 2 * Math.PI * k) / 3));
    }
  }
  const shift = -b / (3 * a);
  return roots.map(y => y + shift).sort((a, b) => a - b);
}

function intermediateHalfLifeMin(pk) {
  const { V1, V2, V3, CL, Q2, Q3 } = pk;
  const k10 = CL / V1, k12 = Q2 / V1, k13 = Q3 / V1;
  const k21 = Q2 / V2, k31 = Q3 / V3;
  // A matrix (3x3 non-effect-site block). Rows act on A1, A2, A3.
  // Characteristic polynomial det(A - λI) = 0.
  // With row-based A:
  //   A = [[-(k10+k12+k13), k21, k31],
  //        [k12, -k21, 0],
  //        [k13, 0, -k31]]
  const a11 = -(k10 + k12 + k13), a12 = k21, a13 = k31;
  const a21 = k12, a22 = -k21;
  const a31 = k13, a33 = -k31;
  // det(A - λI) = expand:
  // = -λ^3 + (a11+a22+a33)λ^2 - (a11 a22 + a11 a33 + a22 a33 - a12 a21 - a13 a31) λ
  //   + (a11 a22 a33 - a12 a21 a33 - a13 a22 a31)
  // Coefficients in order λ^3, λ^2, λ, const:
  const c3 = -1;
  const c2 = a11 + a22 + a33;
  const c1 = -(a11 * a22 + a11 * a33 + a22 * a33 - a12 * a21 - a13 * a31);
  const c0 = a11 * a22 * a33 - a12 * a21 * a33 - a13 * a22 * a31;
  // Convert to a x^3 + b x^2 + c x + d with positive leading coefficient
  const roots = solveCubic(-c3, -c2, -c1, -c0);
  // All roots should be negative real. Sort by magnitude (smallest abs = slowest).
  const sorted = roots.slice().sort((a, b) => Math.abs(a) - Math.abs(b));
  const mid = sorted[1]; // intermediate
  return Math.log(2) / Math.abs(mid);
}

// ---- Test framework ----

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function approx(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(msg || `expected ≈${b}, got ${a} (tol ${tol})`); }

// ---- Tests ----

console.log('\n--- Reconcile: getCumulativeDose ---');

t('bolus-only events sum correctly', () => {
  const events = [
    { type: 'bolus', time: 0, value: 100 },
    { type: 'bolus', time: 5, value: 50 },
  ];
  const { totalMg } = getCumulativeDose(events, 'propofol', 10);
  approx(totalMg, 150, 1e-9);
});

t('rate integrated across segments', () => {
  const events = [
    { type: 'rate', time: 0, value: 5 },    // 5 mg/min
    { type: 'rate', time: 10, value: 2 },   // then 2 mg/min
    { type: 'pause', time: 20, value: 0 },
  ];
  // 0..10 @ 5 = 50; 10..20 @ 2 = 20; 20..30 @ 0 = 0
  const { totalMg } = getCumulativeDose(events, 'propofol', 30);
  approx(totalMg, 70, 1e-9);
});

t('partial rate at now truncates correctly', () => {
  const events = [{ type: 'rate', time: 0, value: 10 }];
  const { totalMg } = getCumulativeDose(events, 'propofol', 7.5);
  approx(totalMg, 75, 1e-9);
});

t('empty events returns zero', () => {
  const { totalMg } = getCumulativeDose([], 'propofol', 10);
  approx(totalMg, 0, 1e-12);
});

console.log('\n--- Reconcile: baseline must match apply-time clock ---');

// The modal opens at t0, the user enters the actual total, and confirm fires
// at t1 > t0 (the case clock keeps running). The correction must be measured
// against the baseline at t1 — the same clock the mutation is applied at —
// so the post-reconcile total lands exactly on the entered actual.
t('single-bolus delta sampled at apply-time lands on actual exactly', () => {
  const events = [{ type: 'rate', time: 0, value: 10 }]; // 10 mg/min infusion
  const t0 = 30;   // modal open
  const t1 = 31.5; // confirm 90s later
  const actual = 400;

  // BUG repro: baseline sampled at open (t0) overshoots at apply-time.
  const baseAtOpen = getCumulativeDose(events, 'propofol', t0).totalMg; // 300
  const deltaStale = actual - baseAtOpen;
  const withStale = [...events, { type: 'bolus', time: t1, value: deltaStale }];
  const totalStale = getCumulativeDose(withStale, 'propofol', t1).totalMg;
  if (Math.abs(totalStale - actual) < 1e-6) {
    throw new Error('expected stale-baseline path to overshoot, but it matched');
  }

  // FIX: baseline sampled at apply-time (t1) lands exactly.
  const baseAtApply = getCumulativeDose(events, 'propofol', t1).totalMg; // 315
  const deltaFresh = actual - baseAtApply;
  const withFresh = [...events, { type: 'bolus', time: t1, value: deltaFresh }];
  const totalFresh = getCumulativeDose(withFresh, 'propofol', t1).totalMg;
  approx(totalFresh, actual, 1e-9, `expected total ${actual}, got ${totalFresh}`);
});

t('spread offset over [0,t1] sampled at apply-time lands on actual exactly', () => {
  const events = [{ type: 'rate', time: 0, value: 10 }];
  const t1 = 31.5;
  const actual = 400;
  const baseAtApply = getCumulativeDose(events, 'propofol', t1).totalMg; // 315
  const delta = actual - baseAtApply;
  const ratePerMin = delta / t1; // spread evenly across [0, t1]
  // Augment the single rate segment by the offset.
  const augmented = [{ type: 'rate', time: 0, value: 10 + ratePerMin }];
  const total = getCumulativeDose(augmented, 'propofol', t1).totalMg;
  approx(total, actual, 1e-9, `expected total ${actual}, got ${total}`);
});

console.log('\n--- Reconcile: negative bolus replay ---');

t('+50mg then -50mg returns drug content toward zero long-term', () => {
  const engA = createEngine(PK);
  const engB = createEngine(PK);
  // A: no drug ever (reference)
  // B: +50 at t=0, then -50 at t=15 min
  // Use a 1-min "bolus" as a 50 mg/min infusion for 1 minute then 0.
  engB.advance(1, 50);    // +50 mg over 1 min
  engB.advance(14, 0);    // coast 14 min
  engB.advance(1, -50);   // -50 mg over 1 min
  engB.advance(14, 0);    // coast 14 min
  // After 30 min, both should agree within a few percent; after 120 min, much tighter.
  const shortCp = engB.getConcentrations().Cp;
  // Keep coasting 90 more minutes
  engB.advance(90, 0);
  const longCp = engB.getConcentrations().Cp;
  if (Math.abs(shortCp) < 1e-6) throw new Error('expected measurable transient at t=30');
  if (Math.abs(longCp) > Math.abs(shortCp) * 0.2) {
    throw new Error(`transient did not decay: short=${shortCp}, long=${longCp}`);
  }
  // And long-term: total mass should converge toward the reference (zero)
  if (Math.abs(longCp) > 0.05) {
    throw new Error(`long-term Cp ${longCp} still far from zero`);
  }
});

t('rate-based negative correction: +50 mg infused then -50 mg retracted', () => {
  const eng = createEngine(PK);
  // Positive 10 mg/min for 5 min = 50 mg
  eng.advance(5, 10);
  const cpAfterInfuse = eng.getConcentrations().Cp;
  // Negative 10 mg/min for 5 min = -50 mg (net zero input)
  eng.advance(5, -10);
  // Coast for 120 min — Cp should approach zero
  eng.advance(120, 0);
  const finalCp = eng.getConcentrations().Cp;
  if (cpAfterInfuse <= 0) throw new Error(`expected positive Cp after infusion, got ${cpAfterInfuse}`);
  if (Math.abs(finalCp) > cpAfterInfuse * 0.05) {
    throw new Error(`net-zero input did not decay: startCp=${cpAfterInfuse} finalCp=${finalCp}`);
  }
});

console.log('\n--- Reconcile: intermediate eigenvalue half-life ---');

t('intermediate half-life is middle-magnitude eigenvalue of A', () => {
  const hl = intermediateHalfLifeMin(PK);
  // For this sample PK, intermediate half-life should land in the clinical
  // propofol-ish range (tens of minutes).
  if (!(hl > 5 && hl < 300)) throw new Error(`hl ${hl} out of clinical range`);
});

t('3 × intermediate half-life falls in 15..360 min range (clamp sanity)', () => {
  const hl = intermediateHalfLifeMin(PK);
  const window = 3 * hl;
  if (!(window > 15 && window < 360)) throw new Error(`3×hl = ${window} outside sanity range`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
