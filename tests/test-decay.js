/**
 * test-decay.js — Tests for trough time prediction (intermittent bolus mode)
 */

// ============ INLINE PK ENGINE ============
const N=4;function mat4(){return new Float64Array(16)}function eye4(){const m=mat4();m[0]=m[5]=m[10]=m[15]=1;return m}
function mul4(A,B){const C=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++){let s=0;for(let k=0;k<N;k++)s+=A[i*N+k]*B[k*N+j];C[i*N+j]=s}return C}
function mulVec4(A,x){const y=new Float64Array(4);for(let i=0;i<N;i++){let s=0;for(let j=0;j<N;j++)s+=A[i*N+j]*x[j];y[i]=s}return y}
function add4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]+B[i];return C}
function sub4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]-B[i];return C}
function scale4(A,s){const B=mat4();for(let i=0;i<16;i++)B[i]=A[i]*s;return B}
function inv4(M){const a=new Float64Array(32);for(let i=0;i<N;i++){for(let j=0;j<N;j++)a[i*8+j]=M[i*N+j];a[i*8+(N+i)]=1}for(let col=0;col<N;col++){let mv=Math.abs(a[col*8+col]),mr=col;for(let r=col+1;r<N;r++){const v=Math.abs(a[r*8+col]);if(v>mv){mv=v;mr=r}}if(mv<1e-15)return null;if(mr!==col)for(let j=0;j<8;j++){const t=a[col*8+j];a[col*8+j]=a[mr*8+j];a[mr*8+j]=t}const p=a[col*8+col];for(let j=0;j<8;j++)a[col*8+j]/=p;for(let r=0;r<N;r++){if(r===col)continue;const f=a[r*8+col];for(let j=0;j<8;j++)a[r*8+j]-=f*a[col*8+j]}}const inv=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++)inv[i*N+j]=a[i*8+(N+j)];return inv}
function expm4(A){const c=[1,1/2,5/44,1/66,1/792,1/15840,1/665280];const nA=(()=>{let mx=0;for(let j=0;j<N;j++){let cs=0;for(let i=0;i<N;i++)cs+=Math.abs(A[i*N+j]);if(cs>mx)mx=cs}return mx})();let s=0;if(nA>0.5){s=Math.ceil(Math.log2(nA/0.5));if(s<0)s=0}const As=(s>0)?scale4(A,1/(1<<s)):A;const As2=mul4(As,As),As3=mul4(As,As2),As4=mul4(As2,As2),As5=mul4(As,As4),As6=mul4(As2,As4);const I=eye4();const powers=[I,As,As2,As3,As4,As5,As6];let Nm=mat4(),Dm=mat4();for(let k=0;k<=6;k++){const sg=(k%2===0)?1:-1;for(let i=0;i<16;i++){Nm[i]+=c[k]*powers[k][i];Dm[i]+=sg*c[k]*powers[k][i]}}const Di=inv4(Dm);if(!Di)return add4(I,A);let result=mul4(Di,Nm);for(let i=0;i<s;i++)result=mul4(result,result);return result}

function sigmoid(x,E50,g){return Math.pow(x,g)/(Math.pow(x,g)+Math.pow(E50,g))}
function fatFreeMass(w,h,a,m){const b=w/Math.pow(h/100,2);if(m)return(.88+(1-.88)/(1+Math.pow(a/13.4,-12.7)))*((9270*w)/(6680+216*b));return(1.11+(1-1.11)/(1+Math.pow(a/7.1,-1.1)))*((9270*w)/(8780+244*b))}
const TH={V1:6.28,V2:25.5,V3:273,CL:1.89,Q2:1.75,Q3:1.11,V2_aging:-0.0156,CL_aging_opioid:-0.00286,V3_aging_opioid:-0.00286,V1_E50_WGT:33.6,CL_female:1.30,CL_mat_PMA50:42.3,CL_mat_hill:9.06,Q3_mat_AGE50:68.3,Q3_mat_hill:1.89,ke0_ref:0.146,ke0_wgt_exp:-0.25};

function calcParams(pt){const{age:a,weight:w,height:h,male:m,opioid:o}=pt;const bmi=w/Math.pow(h/100,2);const ffm=fatFreeMass(w,h,a,m);const pma=(a*52)+40;const of=o?1:0;const WR=70,AR=35;const V1=TH.V1*(sigmoid(w,TH.V1_E50_WGT,1)/sigmoid(WR,TH.V1_E50_WGT,1));const V2=TH.V2*(w/WR)*Math.exp(TH.V2_aging*(a-AR));const fr=fatFreeMass(WR,170,AR,true);const V3=TH.V3*(ffm/fr)*Math.exp(of*TH.V3_aging_opioid*(a-AR));const cm=sigmoid(pma,TH.CL_mat_PMA50,TH.CL_mat_hill)/sigmoid((AR*52+40),TH.CL_mat_PMA50,TH.CL_mat_hill);const CL=TH.CL*Math.pow(w/WR,0.75)*cm*(m?1:TH.CL_female)*Math.exp(of*TH.CL_aging_opioid*(a-AR));const Q2=TH.Q2*Math.pow(V2/TH.V2,0.75);const q3m=sigmoid(a,TH.Q3_mat_AGE50,TH.Q3_mat_hill)/sigmoid(AR,TH.Q3_mat_AGE50,TH.Q3_mat_hill);const Q3=TH.Q3*Math.pow(V3/TH.V3,0.75)*(m?1:q3m);const ke0=TH.ke0_ref*Math.pow(w/WR,TH.ke0_wgt_exp);return{V1,V2,V3,CL,Q2,Q3,ke0}}

function buildSysMat(p){const{V1,V2,V3,CL,Q2,Q3,ke0}=p;const A=mat4();A[0]=-(CL+Q2+Q3)/V1;A[1]=Q2/V2;A[2]=Q3/V3;A[4]=Q2/V1;A[5]=-Q2/V2;A[8]=Q3/V1;A[10]=-Q3/V3;A[12]=ke0/V1;A[15]=-ke0;return A}
function createEngine(p){const A=buildSysMat(p);const{V1,V2,V3}=p;let st=new Float64Array(4);function adv(dt,R){if(dt<=0)return;const e=expm4(scale4(A,dt));const xH=mulVec4(e,st);if(R===0){st=xH;return}const Ai=inv4(A);if(!Ai){st=xH;return}const M=mul4(Ai,sub4(e,eye4()));for(let i=0;i<4;i++)st[i]=xH[i]+M[i*4]*R}function gc(){return{Cp:st[0]/V1,C2:st[1]/V2,C3:st[2]/V3,Ce:st[3],A1:st[0],A2:st[1],A3:st[2]}}function pCe(dt,R){const s=new Float64Array(st);adv(dt,R);const ce=st[3];st=s;return ce}function reset(){st=new Float64Array(4)}function getState(){return new Float64Array(st)}function setState(s){st=new Float64Array(s)}return{advance:adv,getConcentrations:gc,predictCe:pCe,reset,getState,setState,get params(){return p}}}

// ============ INLINE DECAY PREDICTOR ============
function predictTroughTime(engine, startState, startTime, troughCe, currentRate, opts={}) {
  const maxLookahead=opts.maxLookahead||480, coarseStep=opts.coarseStep||0.5, tolerance=opts.tolerance||0.01;
  const saved=engine.getState();
  engine.setState(startState);
  const startCe=engine.getConcentrations().Ce;
  
  // Scan forward looking for Ce to cross the trough from ABOVE.
  // Ce may start below trough (post-bolus, Ce hasn't peaked yet),
  // rise above it, then decay back down through it. We want that
  // downward crossing, not the initial "already below" state.
  engine.setState(startState);
  let prevCe=startCe, hasBeenAbove=(startCe>troughCe);
  let crossStart=null, crossEnd=null;
  
  for(let t=coarseStep;t<=maxLookahead;t+=coarseStep){
    engine.advance(coarseStep,currentRate);
    const ce=engine.getConcentrations().Ce;
    
    if(ce>troughCe) hasBeenAbove=true;
    
    // Look for downward crossing: Ce was above trough, now at or below
    if(hasBeenAbove && prevCe>troughCe && ce<=troughCe){
      crossStart=startTime+(t-coarseStep);
      crossEnd=startTime+t;
      break;
    }
    prevCe=ce;
  }
  
  // If Ce never went above trough at all, it truly is already below
  if(!hasBeenAbove && crossStart===null){
    engine.setState(saved);
    return{time:startTime,ceAtTime:startCe};
  }
  
  if(crossStart===null){
    // Ce went above trough but never came back down within lookahead
    engine.setState(saved);
    return{time:null,ceAtTime:prevCe};
  }
  
  // Bisection refinement
  let loOff=crossStart-startTime,hiOff=crossEnd-startTime;
  for(let i=0;i<40;i++){
    const mid=(loOff+hiOff)/2;
    engine.setState(startState);engine.advance(mid,currentRate);
    const ce=engine.getConcentrations().Ce;
    if(Math.abs(ce-troughCe)<0.0001){engine.setState(saved);return{time:startTime+mid,ceAtTime:ce}}
    if(ce>troughCe)loOff=mid;else hiOff=mid;
    if(hiOff-loOff<tolerance)break;
  }
  const resOff=(loOff+hiOff)/2;
  engine.setState(startState);engine.advance(resOff,currentRate);
  const finalCe=engine.getConcentrations().Ce;
  engine.setState(saved);
  return{time:startTime+resOff,ceAtTime:finalCe};
}

// ============ TESTS ============
let passed=0,failed=0;
function assert(c,m){if(c){passed++;console.log(`  ✓ ${m}`)}else{failed++;console.error(`  ✗ ${m}`)}}

const params=calcParams({age:35,weight:70,height:170,male:true,opioid:false});

console.log('\n=== TEST 1: Trough Time After Bolus (No Infusion) ===');
{
  const eng=createEngine(params);
  
  // Give a 100mg bolus — Ce starts ~0, rises to ~1-2, then decays
  eng.advance(0.05, 100/0.05);
  const postBolusState=eng.getState();
  const postBolusCe=eng.getConcentrations().Ce;
  console.log(`  Immediate post-bolus Ce: ${postBolusCe.toFixed(3)} μg/mL (Ce lags behind Cp)`);

  // Let Ce equilibrate to find peak
  eng.advance(5, 0); // 5 min decay
  const peakCe=eng.getConcentrations().Ce;
  console.log(`  Ce at 5 min (near peak): ${peakCe.toFixed(3)} μg/mL`);

  // Predict when Ce decays to 0.5 μg/mL from the bolus state
  const result=predictTroughTime(eng, postBolusState, 0, 0.5, 0);
  console.log(`  Time to Ce=0.5: ${result.time!==null?result.time.toFixed(1)+' min':'never'}`);
  console.log(`  Ce at that time: ${result.ceAtTime.toFixed(3)}`);

  assert(result.time!==null,'Trough time found');
  assert(result.time>3,'Trough time is well after bolus (Ce must rise first then decay)');
  assert(Math.abs(result.ceAtTime-0.5)<0.02,'Ce at trough time ≈ 0.5');

  // Verify
  eng.setState(postBolusState);
  eng.advance(result.time, 0);
  const verifyCe=eng.getConcentrations().Ce;
  console.log(`  Verification Ce: ${verifyCe.toFixed(3)}`);
  assert(Math.abs(verifyCe-0.5)<0.02,'Verified Ce at predicted time');
}

console.log('\n=== TEST 2: Already Below Trough ===');
{
  const eng=createEngine(params);
  const state=eng.getState();
  const result=predictTroughTime(eng, state, 5.0, 1.0, 0);
  assert(result.time===5.0,'Returns current time when already below trough');
  assert(result.ceAtTime<0.01,'Ce is ~0');
}

console.log('\n=== TEST 3: Multiple Boluses — Trough Shifts ===');
{
  const eng=createEngine(params);
  
  // 50mg bolus
  eng.advance(0.05, 50/0.05);
  const state1=eng.getState();
  const r1=predictTroughTime(eng, state1, 0, 0.3, 0);
  
  // 100mg bolus
  eng.reset();
  eng.advance(0.05, 100/0.05);
  const state2=eng.getState();
  const r2=predictTroughTime(eng, state2, 0, 0.3, 0);

  console.log(`  50mg bolus → trough 0.3 at ${r1.time?.toFixed(1)} min`);
  console.log(`  100mg bolus → trough 0.3 at ${r2.time?.toFixed(1)} min`);

  assert(r1.time!==null&&r2.time!==null,'Both reach trough');
  assert(r2.time>r1.time,'Larger bolus takes longer to decay to trough');
}

console.log('\n=== TEST 4: Low Trough — Long Decay ===');
{
  const eng=createEngine(params);
  eng.advance(0.05, 100/0.05);
  const state=eng.getState();
  
  const result=predictTroughTime(eng, state, 0, 0.05, 0);
  console.log(`  Time to Ce=0.05: ${result.time!==null?result.time.toFixed(1)+' min':'never'}`);
  assert(result.time!==null,'Reaches very low trough eventually');
  assert(result.time>30,'Takes >30 min to reach 0.05 μg/mL');
}

console.log('\n=== TEST 5: High Trough — Near Peak ===');
{
  const eng=createEngine(params);
  eng.advance(0.05, 200/0.05);
  const state=eng.getState();
  
  // Find actual peak Ce by scanning
  eng.setState(state);
  let maxCe=0,maxT=0;
  for(let t=0.5;t<30;t+=0.5){eng.setState(state);eng.advance(t,0);const ce=eng.getConcentrations().Ce;if(ce>maxCe){maxCe=ce;maxT=t}}
  console.log(`  Peak Ce after 200mg: ${maxCe.toFixed(3)} at t=${maxT.toFixed(1)} min`);

  // Trough set to 90% of peak — should find it during the decay phase
  const trough=maxCe*0.9;
  const result=predictTroughTime(eng, state, 0, trough, 0);
  console.log(`  Time to Ce=${trough.toFixed(3)}: ${result.time?.toFixed(1)} min`);
  assert(result.time!==null,'Found trough near peak');
  assert(result.time>maxT,'Trough time is after peak time');
}

console.log('\n=== TEST 6: Trough With Background Infusion ===');
{
  const eng=createEngine(params);
  eng.advance(10, 2.0);
  const state=eng.getState();
  const currentCe=eng.getConcentrations().Ce;
  console.log(`  Ce after 10min at 2mg/min: ${currentCe.toFixed(3)}`);

  // Stop infusion and predict decay to 0.1
  const result=predictTroughTime(eng, state, 10, 0.1, 0);
  console.log(`  Time to Ce=0.1 (no infusion): ${result.time?.toFixed(1)} min`);
  assert(result.time!==null,'Reaches trough after stopping');
  assert(result.time>10,'Trough time is after the start time');
}

console.log('\n=== TEST 7: Engine State Preserved ===');
{
  const eng=createEngine(params);
  eng.advance(0.05, 100/0.05);
  const stateBefore=new Float64Array(eng.getState());
  
  predictTroughTime(eng, eng.getState(), 0, 0.5, 0);
  
  const stateAfter=eng.getState();
  let preserved=true;
  for(let i=0;i<4;i++){if(Math.abs(stateBefore[i]-stateAfter[i])>1e-10){preserved=false;break}}
  assert(preserved,'Engine state unchanged after prediction');
}

// ---- SUMMARY ----
console.log(`\n${'='.repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed>0?1:0);
