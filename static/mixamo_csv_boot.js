import {CsvStudy,selectSamples} from "./mixamo_csv_study.js?v=study3-pages-20261109";

const el=id=>document.getElementById(id);
const scope=new URL("./",import.meta.url).pathname+":study4:7c765185e794";
const tabKey="mixamo_participant_session_csv:"+scope,activeKey="mixamo_csv_active_session:"+scope;
const comparison=new URL("./renders/mbench_vimogen_detailed/mixamo/",import.meta.url);
let study=null,available=null,starting=false,previous=null,downloaded=false;
const study4=document.documentElement.dataset.study4==="true";
document.title=(study4?"Study 4: ":"")+"User Study for Multi-stream Motion Fusion (CSV)";
el("study-intro").hidden=false;el("csv-notice").hidden=false;
const formSubmission=study4||document.documentElement.dataset.study3==="true";
el("csv-form-submit").hidden=!formSubmission;
el("csv-form-help").hidden=!formSubmission;
for(const id of ["search","k","sample","next","settings","time"])el(id).hidden=true;
el("prev").textContent="Review previous";

async function json(url){
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error("Could not load comparison data: HTTP "+response.status);
  return response.json();
}
function assetURL(relative){
  const url=new URL(relative,comparison);
  if(url.origin!==location.origin||!url.pathname.startsWith(new URL("./",import.meta.url).pathname))throw new Error("Invalid comparison asset URL.");
  return url.href;
}
async function loadSample(record){
  const sample=await json(assetURL(record.url));
  if(sample.id!==record.id||sample.k!==record.k||sample.sources.length!==record.k){
    throw new Error("Comparison identity or input count changed.");
  }
  const outputs=Object.fromEntries(await Promise.all(["motionfuse","vimogen"].map(async model=>{
    const output=await json(assetURL(sample.outputs[model]));
    if(output.id!==record.id||!Number.isInteger(output.length)||output.length<1)throw new Error("Invalid comparison output.");
    return [model,{length:output.length,glb:assetURL(output.glb)}];
  })));
  return {
    id:sample.id,k:sample.k,control_text:sample.control_text,fps:sample.fps??20,outputs,
    sources:sample.sources.map((source,index)=>({
      label:"Source "+(index+1),length:source.length,parts:source.parts,mask:source.mask,
      glb:assetURL(source.glb),
    })),
  };
}
function downloadCSV(){
  const url=URL.createObjectURL(new Blob([study.toCSV()],{type:"text/csv;charset=utf-8"}));
  const link=document.createElement("a");
  link.href=url;link.download=(study4?"motion-fusion-study4-":"motion-fusion-study-")+study.data.id+".csv";
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  downloaded=true;el("csv-export-error").textContent="";
}
function showState(next){
  el("study-intro").hidden=true;el("session-toolbar").hidden=false;
  el("session-participant").textContent=next.participant_id?"Participant: "+next.participant_id:"Anonymous participant";
  el("session-progress").textContent=next.answered+" / "+next.total+" saved on this device";
  el("viewer").style.display=next.complete?"none":"flex";
  el("csv-complete").hidden=!next.complete;
  if(next.complete&&previous&&!previous.complete){
    try{downloadCSV();}catch(error){el("csv-export-error").textContent=error.message;}
  }
  previous=next;
  return next.next_sample;
}
async function openSession(current){
  study=current;
  sessionStorage.setItem(tabKey,study.data.id);
  localStorage.setItem(activeKey,study.data.id);
  window.__mixamoStudy={
    saveVote:(id,choice)=>study.recordVote(id,choice),
    onSaved:showState,
    choiceFor:id=>study.data.samples.find(sample=>sample.id===id)?.choice,
    getJSON:url=>study.getJSON(url),
  };
  const next=study.state();
  showState(next);
  if(!next.complete){
    history.replaceState(null,"","#"+encodeURIComponent(next.next_sample));
    await import("./mbench_compare.js?v=shadows-20261109");
  }
}
function updateStart(){
  el("start-session").disabled=!available||starting||!el("instructions-read").checked;
}
el("instructions-read").onchange=updateStart;
el("download-csv").onclick=()=>{
  try{downloadCSV();}catch(error){el("csv-export-error").textContent=error.message;}
};
el("new-participant").onclick=()=>{
  if((!study.state().complete||!downloaded)&&!confirm("Start a new participant? Download your completed CSV first. This session remains stored only in this browser."))return;
  sessionStorage.removeItem(tabKey);localStorage.removeItem(activeKey);
  location.replace(location.pathname+location.search);
};
el("study-start").onsubmit=async event=>{
  event.preventDefault();
  if(starting||!available||!el("instructions-read").checked)return;
  starting=true;updateStart();el("study-start-error").textContent="";
  try{
    const size=available.session_size,fixed=available.fixed_samples;
    const samples=await Promise.all(selectSamples(available.samples,size,fixed).map(loadSample));
    const current=CsvStudy.create({
      participantId:el("participant-id").value,size,fixed,
      catalog:{
        samples,comparison_url:comparison.href,character:available.character,
        character_glb:assetURL(available.character_glb),bones:available.bones,
      },
    });
    await openSession(current);
  }catch(error){el("study-start-error").textContent=error.message;}
  finally{starting=false;updateStart();}
};
try{
  const id=sessionStorage.getItem(tabKey)||localStorage.getItem(activeKey);
  if(id)await openSession(CsvStudy.load(id));
  else{
    const [manifest,status]=await Promise.all([
      json(new URL("manifest.json",comparison)),json(new URL("status.json",comparison)),
    ]);
    if(manifest.render_mode!=="mixamo"||!manifest.character_glb)throw new Error("Shared Mixamo character is unavailable.");
    const motionfuse=new Set(status.motionfuse_ready_ids),vimogen=new Set(status.vimogen_ready_ids);
    const samples=manifest.samples.filter(sample=>[2,3].includes(sample.k)&&motionfuse.has(sample.id)&&vimogen.has(sample.id));
    const size=manifest.session_size??50,fixed=manifest.fixed_samples===true;
    selectSamples(samples,size,fixed);
    available={...manifest,samples,session_size:size,fixed_samples:fixed};
    el("task-summary").textContent="You will review "+size+" comparisons. Outputs are randomly ordered. No names or email addresses are needed.";
    updateStart();
  }
}catch(error){
  el("study-start-error").textContent="Could not open the CSV study. "+error.message;
}
