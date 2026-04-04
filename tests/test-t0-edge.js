/**
 * test-t0-edge.js — t=0 initialization edge case tests
 * 
 * Verifies correct behavior at the boundary of the first interval:
 * - Zero state initialization
 * - Bolus at t=0 from zero state
 * - Rate change at t=0
 * - Simultaneous events at t=0
 * - Querying concentrations at and near t=0
 * - Matrix exponential with zero state vector
 */

// ============ INLINE PK ENGINE ============
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

// ============ PK ENGINE ============
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
    getState(){return new Float64Array(st)},
    setState(s){st=new Float64Array(s)},
    reset(){st=new Float64Array(4)},
    predictCe(dt,R){const sv=new Float64Array(st);const self=this;self.advance(dt,R);const ce=st[3];st=sv;return ce},
  };
}

// ============ MINI EVENT SYSTEM ============
let _nid=1;
function createEvt(drug,time,type,value,opts={}){
  return{id:'e'+(_nid++),drug,time,type,value,status:opts.status||'executed',
    source:opts.source||'manual',snapshot:null,annotation:opts.annotation||''};
}

function createEventList(){
  let events=[];
  const engines={};
  function registerEngine(d,e){engines[d]=e}
  function insert(e){let idx=events.length;for(let i=events.length-1;i>=0;i--){if(events[i].time<=e.time){idx=i+1;break}if(i===0)idx=0}events.splice(idx,0,e);return e}
  function getActiveRateForDrug(d,beforeIdx){for(let i=beforeIdx;i>=0;i--){if(events[i].drug!==d)continue;if(events[i].type==='rate')return events[i].value;if(events[i].type==='pause')return 0}return 0}
  function getRateAtTime(d,time){let r=0;for(const e of events){if(e.drug!==d)continue;if(e.time>time)break;if(e.type==='rate')r=e.value;else if(e.type==='pause')r=0}return r}

  function replayDrug(d){
    const eng=engines[d];if(!eng)return;
    eng.reset();let ct=0,cr=0;
    for(const evt of events){
      if(evt.drug!==d)continue;
      const dt=evt.time-ct;
      if(dt>0)eng.advance(dt,cr);
      ct=evt.time;
      if(evt.type==='bolus'){eng.advance(0.05,evt.value/0.05);ct+=0.05}
      else if(evt.type==='rate')cr=evt.value;
      else if(evt.type==='pause')cr=0;
      evt.snapshot=eng.getState();
    }
  }

  function getConcentrationsAt(d,time){
    const eng=engines[d];if(!eng)return{Cp:0,Ce:0,C2:0,C3:0,rate:0};
    let le=null,li=-1;
    for(let i=events.length-1;i>=0;i--){
      if(events[i].drug===d&&events[i].time<=time){le=events[i];li=i;break}
    }
    if(!le)return{Cp:0,Ce:0,C2:0,C3:0,rate:0};
    if(!le.snapshot)replayDrug(d);
    eng.setState(le.snapshot);
    let ct=le.time;
    if(le.type==='bolus')ct+=0.05;
    const cr=getActiveRateForDrug(d,li);
    const dt=time-ct;
    if(dt>0)eng.advance(dt,cr);
    return{...eng.getConc(),rate:cr};
  }

  function addManualBolus(d,time,mg){
    const pr=getRateAtTime(d,time);
    const be=createEvt(d,time,'bolus',mg);insert(be);
    const re=createEvt(d,time+0.05,'rate',pr,{source:'system'});insert(re);
    replayDrug(d);return be;
  }

  function addManualRate(d,time,rate){
    const e=createEvt(d,time,'rate',rate);insert(e);replayDrug(d);return e;
  }

  function clearAll(){events=[];_nid=1;for(const d of Object.keys(engines))engines[d].reset()}

  return{registerEngine,insert,replayDrug,getConcentrationsAt,addManualBolus,addManualRate,clearAll,
    get raw(){return events},get length(){return events.length}};
}

// Reference patient: 35y/70kg/170cm male, no opioid
const REF = { V1:6.28, V2:25.5, V3:273, CL:1.79, Q2:1.75, Q3:1.11, ke0:0.146 };

// ============ TESTS ============
let passed=0,failed=0;
function ok(cond,msg){if(cond){passed++;console.log(`  ✓ ${msg}`)}else{failed++;console.error(`  ✗ ${msg}`)}}
function near(a,b,tol,msg){const rel=Math.abs(b)>1e-9?Math.abs(a-b)/Math.abs(b):Math.abs(a-b);ok(rel<tol,`${msg} (got ${a.toFixed(6)}, expected ${b.toFixed(6)}, ${(rel*100).toFixed(3)}%)`)}

// ===== GROUP 1: Engine Zero-State Behavior =====
console.log('\n===== 1. Engine Zero-State Initialization =====\n');

{
  const eng = createEngine(REF);
  const c = eng.getConc();
  ok(c.Cp === 0 && c.Ce === 0 && c.C2 === 0 && c.C3 === 0, 
    'Fresh engine returns all-zero concentrations');
}

{
  const eng = createEngine(REF);
  eng.advance(0, 10); // dt=0, should be no-op
  const c = eng.getConc();
  ok(c.Cp === 0 && c.Ce === 0, 'advance(0, R) is a no-op — state stays zero');
}

{
  const eng = createEngine(REF);
  eng.advance(-1, 10); // negative dt, should be no-op
  const c = eng.getConc();
  ok(c.Cp === 0 && c.Ce === 0, 'advance(negative dt, R) is a no-op');
}

{
  const eng = createEngine(REF);
  eng.advance(5, 0); // zero rate, zero state — decay of nothing
  const c = eng.getConc();
  ok(c.Cp === 0 && c.Ce === 0, 'advance(dt, 0) from zero state stays zero');
}

// ===== GROUP 2: Bolus from Zero State =====
console.log('\n===== 2. Bolus from Zero State =====\n');

{
  // 100mg bolus delivered over 0.05 min (3 seconds) — our standard delivery
  const eng = createEngine(REF);
  eng.advance(0.05, 100 / 0.05); // 2000 mg/min for 0.05 min = 100mg
  const c = eng.getConc();
  
  ok(c.Cp > 0, `Bolus from zero: Cp is positive (${c.Cp.toFixed(3)} µg/mL)`);
  ok(c.Ce > 0, `Bolus from zero: Ce is positive (${c.Ce.toFixed(6)} µg/mL)`);
  ok(c.C2 > 0, 'Bolus from zero: C2 is positive (redistribution started)');
  ok(c.C3 > 0, 'Bolus from zero: C3 is positive (redistribution started)');
  
  // Cp should be close to dose/V1 = 100/6.28 ≈ 15.92
  // But after 3 seconds of redistribution it'll be slightly less
  near(c.Cp, 100/REF.V1, 0.02, 'Cp ≈ dose/V1 within 2% after 3s bolus delivery');
}

{
  // Verify the bolus total amount is correct
  const eng = createEngine(REF);
  eng.advance(0.05, 100 / 0.05);
  const s = eng.getState();
  const totalAmount = s[0] + s[1] + s[2]; // A1 + A2 + A3 (Ce is concentration, not amount)
  // Total should be slightly less than 100mg due to elimination during delivery
  ok(totalAmount > 99 && totalAmount < 100.01, 
    `Total amount in compartments = ${totalAmount.toFixed(4)} mg (≈100mg, minus elimination)`);
}

{
  // Two identical approaches should give identical results:
  // Approach A: bolus via high-rate infusion
  const engA = createEngine(REF);
  engA.advance(0.05, 100/0.05);
  engA.advance(4.95, 0); // total 5 min
  
  // Approach B: same but with a reset + restore
  const engB = createEngine(REF);
  engB.advance(0.05, 100/0.05);
  const snapshot = engB.getState();
  engB.reset();
  engB.setState(snapshot);
  engB.advance(4.95, 0);
  
  const cA = engA.getConc();
  const cB = engB.getConc();
  near(cA.Cp, cB.Cp, 1e-10, 'Snapshot save/restore preserves Cp exactly');
  near(cA.Ce, cB.Ce, 1e-10, 'Snapshot save/restore preserves Ce exactly');
}

// ===== GROUP 3: Rate Infusion from Zero State =====
console.log('\n===== 3. Rate Infusion from Zero State =====\n');

{
  const eng = createEngine(REF);
  eng.advance(1, 2.0); // 2 mg/min for 1 minute = 2mg delivered
  const c = eng.getConc();
  ok(c.Cp > 0, `1 min infusion from zero: Cp > 0 (${c.Cp.toFixed(4)})`);
  ok(c.Ce > 0, `1 min infusion from zero: Ce > 0 (${c.Ce.toFixed(6)})`);
  ok(c.Ce < c.Cp, 'Ce lags Cp during initial infusion');
}

// ===== GROUP 4: Event System t=0 Scenarios =====
console.log('\n===== 4. Event System at t=0 =====\n');

{
  // Bolus at t=0
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualBolus('propofol', 0, 100);
  
  ok(el.length === 2, `Bolus at t=0 creates 2 events (bolus + rate restore) [got ${el.length}]`);
  ok(el.raw[0].time === 0 && el.raw[0].type === 'bolus', 'First event is bolus at t=0');
  ok(el.raw[1].time === 0.05 && el.raw[1].type === 'rate', 'Second event is rate restore at t=0.05');
  ok(el.raw[0].snapshot !== null, 'Bolus event has snapshot');
  ok(el.raw[1].snapshot !== null, 'Rate-restore event has snapshot');
}

{
  // Concentrations at t=0 with bolus at t=0
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualBolus('propofol', 0, 100);
  
  // At t=0 exactly — the bolus event is at t=0, its snapshot is POST-bolus (after 0.05 min delivery)
  const c0 = el.getConcentrationsAt('propofol', 0);
  ok(c0.Cp > 0, `getConcentrationsAt(0) with bolus at t=0: Cp > 0 (${c0.Cp.toFixed(3)})`);
  
  // At t=1 — should show decay from the bolus
  const c1 = el.getConcentrationsAt('propofol', 1);
  ok(c1.Cp > 0 && c1.Cp < c0.Cp, 'At t=1, Cp has decayed from post-bolus peak');
  ok(c1.Ce > 0, 'At t=1, Ce is rising toward equilibrium');
}

{
  // Concentrations at t=0 with NO events — should return zeros
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  
  const c = el.getConcentrationsAt('propofol', 0);
  ok(c.Cp === 0 && c.Ce === 0, 'getConcentrationsAt(0) with no events returns zeros');
}

{
  // Rate at t=0 followed by query at t=5
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualRate('propofol', 0, 2.0); // 2 mg/min starting at t=0
  
  // At t=0 itself — rate just programmed, no drug delivered yet
  const c0 = el.getConcentrationsAt('propofol', 0);
  ok(c0.Cp === 0, 'Rate at t=0: Cp=0 at t=0 (pump just started, no drug yet)');
  ok(c0.rate === 2.0, 'Rate at t=0: active rate is 2.0 mg/min');
  
  // At t=5 — should have 5 min of infusion
  const c5 = el.getConcentrationsAt('propofol', 5);
  ok(c5.Cp > 0, `Rate at t=0, query t=5: Cp > 0 (${c5.Cp.toFixed(4)})`);
  
  // Compare with direct engine computation
  const eng = createEngine(REF);
  eng.advance(5, 2.0);
  const cDirect = eng.getConc();
  near(c5.Cp, cDirect.Cp, 1e-6, 'Event-system Cp matches direct engine Cp at t=5');
  near(c5.Ce, cDirect.Ce, 1e-6, 'Event-system Ce matches direct engine Ce at t=5');
}

{
  // Bolus at t=0 followed by rate at t=0 (simultaneous)
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualBolus('propofol', 0, 100);
  // addManualBolus already adds a rate-restore at t=0.05. Now add a real rate:
  el.addManualRate('propofol', 0.05, 5.0); // start infusion right after bolus
  
  const c10 = el.getConcentrationsAt('propofol', 10);
  ok(c10.Cp > 0, 'Bolus+Rate at t=0: concentrations exist at t=10');
  ok(c10.rate === 5.0, 'Active rate at t=10 is 5.0 mg/min');
  
  // Verify against direct engine
  const eng = createEngine(REF);
  eng.advance(0.05, 100/0.05); // bolus
  eng.advance(9.95, 5.0);       // infusion for remaining time
  near(c10.Cp, eng.getConc().Cp, 0.01, 'Bolus+Rate matches direct engine at t=10');
}

// ===== GROUP 5: Matrix Exponential Edge Cases =====
console.log('\n===== 5. Matrix Exponential Edge Cases =====\n');

{
  // expm(A * 0) should equal identity
  const Adt = scale4(mat4(), 0); // zero matrix
  const result = expm4(Adt);
  const I = eye4();
  let maxDiff = 0;
  for(let i = 0; i < 16; i++) maxDiff = Math.max(maxDiff, Math.abs(result[i] - I[i]));
  ok(maxDiff < 1e-14, `expm(0) = I (max diff ${maxDiff.toExponential(2)})`);
}

{
  // expm(A * very_small_dt) should be close to I + A*dt
  const eng = createEngine(REF);
  const A = mat4();
  A[0]=-(REF.CL+REF.Q2+REF.Q3)/REF.V1; A[1]=REF.Q2/REF.V2; A[2]=REF.Q3/REF.V3;
  A[4]=REF.Q2/REF.V1; A[5]=-REF.Q2/REF.V2;
  A[8]=REF.Q3/REF.V1; A[10]=-REF.Q3/REF.V3;
  A[12]=REF.ke0/REF.V1; A[15]=-REF.ke0;
  
  const dt = 1e-8; // tiny timestep
  const Adt = scale4(A, dt);
  const result = expm4(Adt);
  const I = eye4();
  // For tiny dt: expm(A*dt) ≈ I + A*dt
  let maxRelDiff = 0;
  for(let i = 0; i < 16; i++){
    const expected = I[i] + Adt[i];
    const diff = Math.abs(result[i] - expected);
    const scale = Math.max(Math.abs(expected), 1e-15);
    maxRelDiff = Math.max(maxRelDiff, diff/scale);
  }
  ok(maxRelDiff < 1e-3, `expm(A*ε) ≈ I + A*ε for tiny ε (max rel diff ${maxRelDiff.toExponential(2)})`);
}

// ===== GROUP 6: Continuity at Bolus Delivery Boundary =====
console.log('\n===== 6. Continuity Across Bolus Delivery =====\n');

{
  // The bolus is delivered over 0.05 min. Verify that querying at t=0.05
  // (end of delivery) and t=0.06 (just after) shows smooth continuation.
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualBolus('propofol', 0, 100);
  
  const c_at = el.getConcentrationsAt('propofol', 0.05);
  const c_after = el.getConcentrationsAt('propofol', 0.06);
  
  // Cp should be decreasing after bolus (redistribution)
  ok(c_after.Cp < c_at.Cp || Math.abs(c_after.Cp - c_at.Cp) < 0.01,
    'Cp is continuous/decreasing across bolus delivery boundary');
  ok(c_after.Ce >= c_at.Ce || Math.abs(c_after.Ce - c_at.Ce) < 0.001,
    'Ce is continuous/rising across bolus delivery boundary');
}

{
  // Verify total delivered drug is correct
  // 100mg bolus: at t=0.05 (end of delivery), sum of amounts should ≈ 100mg
  const eng = createEngine(REF);
  eng.advance(0.05, 100/0.05);
  const s = eng.getState();
  const total = s[0] + s[1] + s[2]; // A1+A2+A3 (not Ce — it's concentration)
  // Some drug eliminated during 3s delivery, so slightly < 100
  const eliminated = 100 - total;
  ok(eliminated >= 0 && eliminated < 1.0,
    `Bolus conservation: ${total.toFixed(3)} mg in compartments, ${eliminated.toFixed(4)} mg eliminated during delivery`);
}

// ===== GROUP 7: Multiple Drugs at t=0 =====
console.log('\n===== 7. Multi-Drug at t=0 =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  // Fentanyl with different PK params (just for isolation test)
  el.registerEngine('fentanyl', createEngine({V1:10, V2:30, V3:200, CL:1.0, Q2:1.5, Q3:0.8, ke0:0.1}));
  
  el.addManualBolus('propofol', 0, 100);
  el.addManualBolus('fentanyl', 0, 0.1); // 100 mcg = 0.1 mg
  
  const cp = el.getConcentrationsAt('propofol', 1);
  const cf = el.getConcentrationsAt('fentanyl', 1);
  
  ok(cp.Cp > 0, 'Propofol has concentrations at t=1 after t=0 bolus');
  ok(cf.Cp > 0, 'Fentanyl has concentrations at t=1 after t=0 bolus');
  
  // Verify isolation: propofol Cp should be much larger (100mg vs 0.1mg)
  ok(cp.Cp > cf.Cp * 10, 'Drug engines are isolated — propofol Cp >> fentanyl Cp');
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
