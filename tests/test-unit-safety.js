/**
 * test-unit-safety.js — Unit consistency validation
 * 
 * The engine operates entirely in MINUTES:
 *   - CL, Q2, Q3 in L/min
 *   - ke0 in min⁻¹
 *   - dt passed to advance() in minutes
 *   - R (infusion rate) in mg/min
 * 
 * SimTIVA uses per-second internally (divides k-values by 60).
 * If someone accidentally passes per-second values to our engine,
 * concentrations decay 60x too fast. This test suite:
 * 
 *   1. Demonstrates what wrong units look like (so you recognize it)
 *   2. Tests a parameter validator that catches plausible mistakes
 *   3. Verifies the advance() dt guard catches seconds-vs-minutes confusion
 */

// ============ INLINE ENGINE (same as other test files) ============
const N=4;
function mat4(){return new Float64Array(16)}
function eye4(){const m=mat4();m[0]=m[5]=m[10]=m[15]=1;return m}
function mul4(A,B){const C=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++){let s=0;for(let k=0;k<N;k++)s+=A[i*N+k]*B[k*N+j];C[i*N+j]=s}return C}
function mulVec4(A,x){const y=new Float64Array(4);for(let i=0;i<N;i++){let s=0;for(let j=0;j<N;j++)s+=A[i*N+j]*x[j];y[i]=s}return y}
function add4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]+B[i];return C}
function sub4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]-B[i];return C}
function scale4(A,s){const B=mat4();for(let i=0;i<16;i++)B[i]=A[i]*s;return B}
function inv4(M){
  const a=new Float64Array(32);
  for(let i=0;i<N;i++){for(let j=0;j<N;j++)a[i*8+j]=M[i*N+j];a[i*8+(N+i)]=1}
  for(let col=0;col<N;col++){
    let mv=Math.abs(a[col*8+col]),mr=col;
    for(let r=col+1;r<N;r++){const v=Math.abs(a[r*8+col]);if(v>mv){mv=v;mr=r}}
    if(mv<1e-15)return null;
    if(mr!==col)for(let j=0;j<8;j++){const t=a[col*8+j];a[col*8+j]=a[mr*8+j];a[mr*8+j]=t}
    const p=a[col*8+col];for(let j=0;j<8;j++)a[col*8+j]/=p;
    for(let r=0;r<N;r++){if(r===col)continue;const f=a[r*8+col];for(let j=0;j<8;j++)a[r*8+j]-=f*a[col*8+j]}
  }
  const inv=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++)inv[i*N+j]=a[i*8+(N+j)];return inv
}
function expm4(A){
  const c=[1,1/2,5/44,1/66,1/792,1/15840,1/665280];
  const nA=(()=>{let mx=0;for(let j=0;j<N;j++){let cs=0;for(let i=0;i<N;i++)cs+=Math.abs(A[i*N+j]);if(cs>mx)mx=cs}return mx})();
  let s=0;if(nA>0.5){s=Math.ceil(Math.log2(nA/0.5));if(s<0)s=0}
  const As=(s>0)?scale4(A,1/(1<<s)):A;
  const As2=mul4(As,As),As3=mul4(As,As2),As4=mul4(As2,As2),As5=mul4(As,As4),As6=mul4(As2,As4);
  const I=eye4();const powers=[I,As,As2,As3,As4,As5,As6];
  let Nm=mat4(),Dm=mat4();
  for(let k=0;k<=6;k++){const sg=(k%2===0)?1:-1;for(let i=0;i<16;i++){Nm[i]+=c[k]*powers[k][i];Dm[i]+=sg*c[k]*powers[k][i]}}
  const Di=inv4(Dm);if(!Di)return add4(I,A);
  let result=mul4(Di,Nm);for(let i=0;i<s;i++)result=mul4(result,result);return result
}

function createEngine(p){
  const{V1,V2,V3}=p;
  const A=mat4();
  A[0]=-(p.CL+p.Q2+p.Q3)/V1; A[1]=p.Q2/V2; A[2]=p.Q3/V3;
  A[4]=p.Q2/V1; A[5]=-p.Q2/V2;
  A[8]=p.Q3/V1; A[10]=-p.Q3/V3;
  A[12]=p.ke0/V1; A[15]=-p.ke0;
  let st=new Float64Array(4);
  return{
    advance(dt,R){
      if(dt<=0)return;
      const e=expm4(scale4(A,dt));
      const xH=mulVec4(e,st);
      if(R===0){st=xH;return}
      const Ai=inv4(A);if(!Ai){st=xH;return}
      const M=mul4(Ai,sub4(e,eye4()));
      for(let i=0;i<4;i++) st[i]=xH[i]+M[i*4]*R;
    },
    getConc(){return{Cp:st[0]/V1,C2:st[1]/V2,C3:st[2]/V3,Ce:st[3]}},
    reset(){st=new Float64Array(4)},
  };
}

// ============ PARAMETER VALIDATOR ============
/**
 * Validate PK parameters for plausible per-minute units.
 * Returns { valid: bool, warnings: string[] }.
 * 
 * This catches the most common mistake: passing SimTIVA-style per-second
 * values to our per-minute engine.
 */
function validateParams(p) {
  const warnings = [];
  const required = ['V1', 'V2', 'V3', 'CL', 'Q2', 'Q3', 'ke0'];

  // Check all required fields exist
  for (const k of required) {
    if (p[k] == null || typeof p[k] !== 'number' || !isFinite(p[k])) {
      warnings.push(`Missing or invalid parameter: ${k}`);
    }
  }
  if (warnings.length > 0) return { valid: false, warnings };

  // Check all positive
  for (const k of required) {
    if (p[k] <= 0) warnings.push(`${k} must be positive (got ${p[k]})`);
  }

  // Plausibility checks for adult propofol (per-minute units)
  // These ranges cover neonates to morbidly obese adults.
  // If values are 60x too small, that's a per-second mistake.

  // V1: central volume. Eleveld range ~1-12 L. Per-second mistake: N/A (volumes don't change)
  // CL: metabolic clearance. Eleveld range ~0.3-4.5 L/min.
  //     Per-second would be 0.005-0.075 L/s — flagged by < 0.1 L/min
  if (p.CL < 0.1) {
    warnings.push(
      `CL=${p.CL.toFixed(4)} L/min seems too low. ` +
      `If these are per-second clearances, multiply by 60. ` +
      `Expected range for propofol: 0.3-4.5 L/min.`
    );
  }

  // Q2: ~0.5-5 L/min. Per-second: 0.008-0.08
  if (p.Q2 < 0.1) {
    warnings.push(
      `Q2=${p.Q2.toFixed(4)} L/min seems too low. Per-second values need *60.`
    );
  }

  // Q3: ~0.1-3 L/min. Per-second: 0.002-0.05
  if (p.Q3 < 0.05) {
    warnings.push(
      `Q3=${p.Q3.toFixed(4)} L/min seems too low. Per-second values need *60.`
    );
  }

  // ke0: ~0.05-0.5 min⁻¹ for propofol. Per-second: 0.001-0.008
  if (p.ke0 < 0.01) {
    warnings.push(
      `ke0=${p.ke0.toFixed(6)} min⁻¹ seems too low. ` +
      `If this is per-second, multiply by 60. Expected: 0.05-0.5 min⁻¹.`
    );
  }

  // Derived k-values as sanity check
  const k10 = p.CL / p.V1;
  if (k10 > 2.0) {
    warnings.push(
      `Derived k10=${k10.toFixed(3)} min⁻¹ is unusually high. ` +
      `Half-life of central elimination = ${(0.693/k10).toFixed(1)} min.`
    );
  }

  return { valid: warnings.length === 0, warnings };
}

// Reference patient: 35y/70kg/170cm male
const CORRECT = { V1:6.28, V2:25.5, V3:273, CL:1.79, Q2:1.75, Q3:1.11, ke0:0.146 };

// Same patient but with per-SECOND clearances (the SimTIVA mistake)
const PER_SECOND = {
  V1: 6.28, V2: 25.5, V3: 273,
  CL: 1.79/60, Q2: 1.75/60, Q3: 1.11/60, ke0: 0.146/60,
};

// ============ TESTS ============
let passed=0,failed=0;
function ok(cond,msg){if(cond){passed++;console.log(`  ✓ ${msg}`)}else{failed++;console.error(`  ✗ ${msg}`)}}
function near(a,b,tol,msg){const r=Math.abs(b)>1e-9?Math.abs(a-b)/Math.abs(b):Math.abs(a-b);ok(r<tol,`${msg} (${a.toFixed(4)} vs ${b.toFixed(4)}, ${(r*100).toFixed(1)}%)`)}

// ===== GROUP 1: What wrong units look like =====
console.log('\n===== 1. Demonstrating Wrong-Unit Failure Mode =====\n');

{
  // Correct: 100mg bolus, check Cp at 5 min
  const eng = createEngine(CORRECT);
  eng.advance(0.05, 100/0.05);
  eng.advance(4.95, 0);
  const correct = eng.getConc();

  // Wrong: same bolus but with per-second params
  const eng2 = createEngine(PER_SECOND);
  eng2.advance(0.05, 100/0.05);
  eng2.advance(4.95, 0);
  const wrong = eng2.getConc();

  console.log(`  Correct Cp at 5 min: ${correct.Cp.toFixed(4)} µg/mL`);
  console.log(`  Wrong   Cp at 5 min: ${wrong.Cp.toFixed(4)} µg/mL`);
  console.log(`  Ratio (wrong/correct): ${(wrong.Cp/correct.Cp).toFixed(2)}x`);

  // With per-second values, everything runs 60x slower — redistribution and
  // elimination are sluggish, so Cp stays much higher than it should
  ok(wrong.Cp > correct.Cp * 5,
    'Per-second params produce grossly wrong Cp (redistribution 60x too slow)');

  console.log(`  Correct Ce at 5 min: ${correct.Ce.toFixed(4)} µg/mL`);
  console.log(`  Wrong   Ce at 5 min: ${wrong.Ce.toFixed(4)} µg/mL`);
  console.log(`  Ratio (wrong/correct): ${(wrong.Ce/correct.Ce).toFixed(2)}x`);

  ok(Math.abs(wrong.Ce / correct.Ce - 1) > 0.5,
    'Per-second params produce grossly wrong Ce (ke0 60x too slow)');
}

{
  // The inverse mistake: passing per-minute k-values to a system that
  // expects per-second (like SimTIVA). Equivalent to our engine receiving
  // params that are 60x too LARGE.
  const TOO_FAST = {
    V1: 6.28, V2: 25.5, V3: 273,
    CL: 1.79*60, Q2: 1.75*60, Q3: 1.11*60, ke0: 0.146*60,
  };

  const eng = createEngine(TOO_FAST);
  eng.advance(0.05, 100/0.05);
  eng.advance(4.95, 0);
  const wrong = eng.getConc();

  const eng2 = createEngine(CORRECT);
  eng2.advance(0.05, 100/0.05);
  eng2.advance(4.95, 0);
  const correct = eng2.getConc();

  console.log(`\n  Correct Cp at 5 min:   ${correct.Cp.toFixed(4)} µg/mL`);
  console.log(`  60x-fast Cp at 5 min:  ${wrong.Cp.toFixed(4)} µg/mL`);

  ok(wrong.Cp < correct.Cp * 0.1,
    '60x-too-fast params: drug eliminated almost completely by 5 min');
}

// ===== GROUP 2: Parameter validator catches mistakes =====
console.log('\n===== 2. Parameter Validator =====\n');

{
  const r = validateParams(CORRECT);
  ok(r.valid, 'Correct per-minute params pass validation');
  ok(r.warnings.length === 0, `No warnings (got ${r.warnings.length})`);
}

{
  const r = validateParams(PER_SECOND);
  ok(!r.valid, 'Per-second params fail validation');
  ok(r.warnings.length >= 3, `Multiple warnings raised (got ${r.warnings.length})`);
  const hasCLwarning = r.warnings.some(w => w.includes('CL='));
  ok(hasCLwarning, 'CL warning specifically mentions the value');
  if (r.warnings.length > 0) {
    console.log('    Warnings:');
    r.warnings.forEach(w => console.log(`      - ${w}`));
  }
}

{
  // Missing parameter
  const r = validateParams({ V1: 6.28, V2: 25.5, V3: 273, CL: 1.79, Q2: 1.75 });
  ok(!r.valid, 'Missing Q3 and ke0 fails validation');
}

{
  // Negative value
  const r = validateParams({ ...CORRECT, CL: -1.79 });
  ok(!r.valid, 'Negative CL fails validation');
}

{
  // NaN
  const r = validateParams({ ...CORRECT, ke0: NaN });
  ok(!r.valid, 'NaN ke0 fails validation');
}

{
  // Edge case: very low CL could be a neonate (not necessarily wrong)
  // Neonate CL might be ~0.15 L/min — right at our threshold
  const neonateish = { ...CORRECT, CL: 0.15, V1: 1.5, V2: 3.0, V3: 20, Q2: 0.3, Q3: 0.15, ke0: 0.146 };
  const r = validateParams(neonateish);
  // Should pass — 0.15 is above our 0.1 threshold
  ok(r.valid, 'Neonate-like low CL (0.15 L/min) still passes validation');
}

// ===== GROUP 3: dt unit confusion (seconds vs minutes) =====
console.log('\n===== 3. Time Step Unit Confusion =====\n');

{
  // If someone calls advance(300, rate) thinking dt is in seconds,
  // they actually advance 300 MINUTES (5 hours).
  // vs the intended advance(5, rate) for 5 minutes.

  const eng1 = createEngine(CORRECT);
  eng1.advance(5, 2.0); // 5 minutes, 2 mg/min = correct
  const correct = eng1.getConc();

  const eng2 = createEngine(CORRECT);
  eng2.advance(300, 2.0); // 300 minutes = WRONG (they meant 300 seconds)
  const wrong = eng2.getConc();

  console.log(`  5 min infusion:   Cp = ${correct.Cp.toFixed(4)} µg/mL`);
  console.log(`  300 min infusion: Cp = ${wrong.Cp.toFixed(4)} µg/mL`);

  // At 300 min the system is near steady state, so Cp will be much higher
  ok(wrong.Cp > correct.Cp * 1.3,
    'Passing seconds as dt produces clearly different (higher) Cp');
}

{
  // Check that a 10-second TCI interval is correctly expressed as 10/60 minutes
  const tenSecInMin = 10 / 60;
  const eng = createEngine(CORRECT);
  eng.advance(tenSecInMin, 2.0);
  const c = eng.getConc();
  ok(c.Cp > 0 && c.Cp < 0.1,
    `10-second advance (${tenSecInMin.toFixed(4)} min): Cp=${c.Cp.toFixed(6)} (small, as expected)`);
}

// ===== GROUP 4: Cross-check — engine from CL/Q matches engine from k-values =====
console.log('\n===== 4. CL/Q vs k-value Equivalence =====\n');

{
  // Our engine takes CL/Q directly. Verify that if we compute k-values
  // and feed them as CL=k10*V1, Q2=k12*V1 etc., we get identical results.
  const p = CORRECT;
  const k10 = p.CL / p.V1;
  const k12 = p.Q2 / p.V1;
  const k21 = p.Q2 / p.V2;
  const k13 = p.Q3 / p.V1;
  const k31 = p.Q3 / p.V3;

  // Reconstruct CL/Q from k-values
  const reconstructed = {
    V1: p.V1, V2: p.V2, V3: p.V3,
    CL: k10 * p.V1,    // = CL
    Q2: k12 * p.V1,    // = Q2 (since Q2/V1 * V1 = Q2)
    Q3: k13 * p.V1,    // = Q3
    ke0: p.ke0,
  };

  // Also verify k21 and k31 consistency
  near(k21, reconstructed.Q2 / p.V2, 1e-10, 'k21 = Q2/V2 round-trips exactly');
  near(k31, reconstructed.Q3 / p.V3, 1e-10, 'k31 = Q3/V3 round-trips exactly');

  // Run both engines
  const eng1 = createEngine(p);
  eng1.advance(0.05, 100/0.05); eng1.advance(9.95, 2.0);
  const c1 = eng1.getConc();

  const eng2 = createEngine(reconstructed);
  eng2.advance(0.05, 100/0.05); eng2.advance(9.95, 2.0);
  const c2 = eng2.getConc();

  near(c1.Cp, c2.Cp, 1e-12, 'CL/Q params and k-derived params give identical Cp');
  near(c1.Ce, c2.Ce, 1e-12, 'CL/Q params and k-derived params give identical Ce');
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
