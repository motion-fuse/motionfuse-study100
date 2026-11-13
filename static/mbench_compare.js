import * as THREE from "three";
import {OrbitControls} from "./vendor/three/examples/jsm/controls/OrbitControls.js";
import {GLTFLoader} from "./vendor/three/examples/jsm/loaders/GLTFLoader.js";

const el=id=>document.getElementById(id);
const base=new URL(".",location.href);
const voting=window.__mixamoVoting===true;
const participantStudy=window.__mixamoStudy;
const apiURL=url=>url.startsWith("/api/")?(window.__mixamoApiPrefix||"")+url:url;
let manifest,status,filtered=[],views=[],selected=null,selection=0,frame=0,playing=true,lastTime=null;
let syncing=false,loadController=null;
let voteSaving=false,voteChoice=null;
let sharedCharacterPromise=null;
function baselineKey(){return manifest.baseline_key||"mosaic";}
function baselineName(){return manifest.baseline_name||"MoSAIC";}
function simpleComparison(){return !voting&&manifest.baseline_key==="vimogen";}
function updateVoting(message){
  if(!voting)return;
  const ready=selected&&views.length===selected.k+2&&views.every(view=>view.character);
  document.querySelectorAll("[data-choice]").forEach(button=>{
    button.disabled=!ready||voteSaving;
    button.setAttribute("aria-pressed",String(button.dataset.choice===voteChoice));
  });
  el("vote-status").textContent=message||(!ready?"Loading all characters...":
    voteChoice?"Vote saved. You can change it or move to the next sample.":"Compare A and B, then vote.");
}
const renderer=new THREE.WebGLRenderer({canvas:el("canvas"),antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setClearColor(0x0f1117);
renderer.setScissorTest(true);
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;

function report(error){
  el("error").hidden=false;el("error").textContent=String(error.message||error);
  console.error(error);
  if(voting)updateVoting("Could not load or save. "+(error.message||error));
}
async function getJSON(url,signal){
  if(participantStudy?.getJSON)return participantStudy.getJSON(url,signal);
  const response=await fetch(new URL(apiURL(url),base),{
    cache:"no-store",signal,headers:requestHeaders(),
  });
  if(!response.ok)throw new Error(url+": HTTP "+response.status);
  return response.json();
}
function requestHeaders(){
  const headers=voting?{"X-Mixamo-Playback":"shared-v1"}:{};
  if(participantStudy?.token)headers["X-Study-Session"]=participantStudy.token;
  return headers;
}
async function saveVote(id,choice){
  if(participantStudy?.saveVote)return participantStudy.saveVote(id,choice);
  const response=await fetch(apiURL("/api/vote/sample/"+encodeURIComponent(id)),{
    method:"POST",headers:{...requestHeaders(),"Content-Type":"application/json"},
    body:JSON.stringify({choice}),
  });
  if(!response.ok)throw new Error("Vote not saved: HTTP "+response.status);
  return response.json();
}
function validFrames(frames){
  return Array.isArray(frames)&&frames.length>0&&frames.every(pose=>
    Array.isArray(pose)&&pose.length===22&&pose.every(joint=>
      Array.isArray(joint)&&joint.length===3&&joint.every(Number.isFinite)));
}
function disposeObject(object){
  const geometries=new Set(),materials=new Set(),textures=new Set();
  object.traverse(child=>{
    if(child.isSkinnedMesh)child.skeleton.dispose();
    if(child.userData.sharedCharacter)return;
    if(child.isLight)child.dispose?.();
    if(child.geometry)geometries.add(child.geometry);
    for(const material of child.material?(Array.isArray(child.material)?child.material:[child.material]):[]){
      materials.add(material);
      for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    }
  });
  geometries.forEach(item=>item.dispose());
  materials.forEach(item=>item.dispose());
  textures.forEach(item=>item.dispose());
}
function clearViews(){
  for(const view of views){
    view.controls.dispose();
    if(view.mixer){view.mixer.stopAllAction();view.mixer.uncacheRoot(view.character);}
    disposeObject(view.scene);
    if(view.scene.background?.isTexture)view.scene.background.dispose();
  }
  views=[];el("panes").replaceChildren();
}
function linkCamera(source){
  if(syncing||!el("sync").checked)return;
  syncing=true;
  for(const view of views){
    if(view===source)continue;
    view.camera.position.copy(source.camera.position);
    view.camera.quaternion.copy(source.camera.quaternion);
    view.controls.target.copy(source.controls.target);
    view.controls.update();
  }
  syncing=false;
}
function makeView(label,detail,mask=null){
  const panel=document.createElement("div");panel.className="pane";
  const heading=document.createElement("div");heading.className="label";
  const title=document.createElement("strong");title.textContent=label;
  const subtitle=document.createElement("small");subtitle.textContent=detail;subtitle.title=detail;
  const counter=document.createElement("small");
  heading.append(title);
  if(!participantStudy){if(detail)heading.append(subtitle);heading.append(counter);}
  panel.append(heading);
  const pending=document.createElement("div");pending.className="pending";pending.textContent="Awaiting inference...";
  panel.append(pending);el("panes").append(panel);
  const scene=new THREE.Scene();
  const skyCanvas=document.createElement("canvas");skyCanvas.width=16;skyCanvas.height=256;
  const skyContext=skyCanvas.getContext("2d");
  const skyGradient=skyContext.createLinearGradient(0,0,0,256);
  skyGradient.addColorStop(0,"#6bb2df");skyGradient.addColorStop(.5,"#b9dff0");
  skyGradient.addColorStop(1,"#b9dff0");
  skyContext.fillStyle=skyGradient;skyContext.fillRect(0,0,16,256);
  scene.background=new THREE.CanvasTexture(skyCanvas);
  scene.background.encoding=THREE.sRGBEncoding;
  scene.fog=new THREE.Fog(0xb9dff0,12,65);
  scene.add(new THREE.AmbientLight(0xffffff,.75));
  const light=new THREE.DirectionalLight(0xffffff,.9);light.position.set(3,6,4);
  light.castShadow=true;light.shadow.mapSize.set(1024,1024);
  Object.assign(light.shadow.camera,{left:-3,right:3,top:3,bottom:-3,near:.1,far:20});
  light.shadow.camera.updateProjectionMatrix();
  light.shadow.bias=-.0002;light.shadow.normalBias=.02;
  scene.add(light,light.target);
  const ground=new THREE.Mesh(
    new THREE.PlaneGeometry(200,200),
    new THREE.MeshPhongMaterial({
      color:0x398fb7,specular:0x9bd5ed,shininess:85,
    }),
  );
  ground.rotation.x=-Math.PI/2;ground.position.y=-.04;ground.receiveShadow=true;scene.add(ground);
  const camera=new THREE.PerspectiveCamera(45,1,.01,1000);
  const controls=new OrbitControls(camera,panel);controls.enableDamping=true;
  const sphere=new THREE.SphereGeometry(.028,10,8),cylinder=new THREE.CylinderGeometry(.012,.012,1,8);
  const joints=Array.from({length:22},()=>{
    const joint=new THREE.Mesh(sphere,new THREE.MeshStandardMaterial({color:0xffffff}));
    scene.add(joint);return joint;
  });
  const bones=manifest.bones.map(([a,b,color])=>{
    const bone=new THREE.Mesh(cylinder,new THREE.MeshStandardMaterial({color}));
    scene.add(bone);return {bone,a,b,color};
  });
  const view={panel,pending,counter,scene,camera,controls,light,joints,bones,mask,frames:null,length:1,loading:false};
  controls.addEventListener("change",()=>linkCamera(view));
  views.push(view);setVisible(view,false);return view;
}
function setVisible(view,visible){
  for(const joint of view.joints)joint.visible=visible;
  for(const {bone} of view.bones)bone.visible=visible;
}
function colors(view){
  const highlight=el("highlight").checked&&view.mask;
  view.joints.forEach((joint,i)=>{
    const owned=!highlight||view.mask[i];
    joint.material.color.set(owned?(highlight?0xa3e635:0xffffff):0x667085);
    joint.material.transparent=!owned;joint.material.opacity=owned?1:.35;
  });
  for(const {bone,a,b,color} of view.bones){
    const owned=!highlight||(view.mask[a]&&view.mask[b]);
    bone.material.color.set(owned?color:0x667085);
    bone.material.transparent=!owned;bone.material.opacity=owned?1:.3;
  }
}
function resetCameras(){
  syncing=true;
  for(const view of views){
    view.camera.position.set(.7,1.7,3.8);view.controls.target.set(0,1,0);view.controls.update();
  }
  syncing=false;
}
function installFrames(view,frames){
  if(!validFrames(frames))throw new Error("Invalid 22-joint frame data");
  view.frames=frames;view.length=frames.length;view.pending.hidden=true;setVisible(view,true);colors(view);
  el("timeline").max=Math.max(...views.map(item=>item.length))-1;
}
async function installCharacter(view,url,length,token){
  view.pending.textContent="Loading character...";
  const loader=new GLTFLoader();
  if(participantStudy)loader.setRequestHeader(requestHeaders());
  let gltf;
  if(manifest.character_glb){
    if(!sharedCharacterPromise){
      sharedCharacterPromise=loader.loadAsync(new URL(manifest.character_glb,base).href)
        .catch(error=>{sharedCharacterPromise=null;throw error;});
    }
    const [template,motion]=await Promise.all([sharedCharacterPromise,loader.loadAsync(new URL(url,base).href)]);
    const scene=template.scene.clone(true),originals=[],copies=[];
    template.scene.traverse(node=>originals.push(node));
    scene.traverse(node=>{copies.push(node);node.userData.sharedCharacter=true;});
    const cloneMap=new Map(originals.map((node,index)=>[node,copies[index]]));
    for(const original of originals){
      if(!original.isSkinnedMesh)continue;
      const copy=cloneMap.get(original);
      copy.skeleton=original.skeleton.clone();
      copy.skeleton.bones=original.skeleton.bones.map(bone=>cloneMap.get(bone));
      copy.bind(copy.skeleton,original.bindMatrix);
    }
    const byName=new Map(copies.map(node=>[node.name,node]));
    motion.scene.traverse(node=>{
      const copy=byName.get(node.name);
      if(copy){
        copy.position.copy(node.position);copy.quaternion.copy(node.quaternion);copy.scale.copy(node.scale);
      }
    });
    gltf={scene,animations:motion.animations};
  }else gltf=await loader.loadAsync(new URL(url,base).href);
  if(token!==selection){disposeObject(gltf.scene);return;}
  if(!Number.isInteger(length)||length<1||gltf.animations.length!==1){
    disposeObject(gltf.scene);throw new Error("Expected one baked animation and a positive frame count");
  }
  const character=new THREE.Group();character.add(gltf.scene);
  let pelvis,left,right,skinned=0;
  character.traverse(child=>{
    if(child.isLight||(child.isMesh&&!child.isSkinnedMesh))child.visible=false;
    if(child.isSkinnedMesh){skinned++;child.castShadow=true;}
    if(!child.isBone)return;
    // GLTFLoader sanitizes "mixamorig:Hips" to "mixamorigHips".
    const name=child.name.split(":").pop().replace(/^mixamorig/,"");
    if(name==="Hips")pelvis=child;
    if(name==="LeftArm")left=child;
    if(name==="RightArm")right=child;
  });
  if(!pelvis||!left||!right||!skinned){
    disposeObject(character);throw new Error("Character is missing its skin or required Mixamo bones");
  }
  view.scene.add(character);view.character=character;view.pelvis=pelvis;
  view.mixer=new THREE.AnimationMixer(character);
  view.action=view.mixer.clipAction(gltf.animations[0]).play();view.action.paused=true;
  view.action.time=Math.min(.05,gltf.animations[0].duration-1e-6);view.mixer.update(0);
  character.updateMatrixWorld(true);
  const across=left.getWorldPosition(new THREE.Vector3()).sub(right.getWorldPosition(new THREE.Vector3()));
  character.rotation.y=Math.atan2(across.z,across.x);character.updateMatrixWorld(true);
  view.initialRoot=pelvis.getWorldPosition(new THREE.Vector3());
  view.floor=Infinity;
  character.traverse(child=>{
    if(child.isBone)view.floor=Math.min(view.floor,child.getWorldPosition(new THREE.Vector3()).y);
  });
  view.length=length;view.pending.hidden=true;
  el("timeline").max=Math.max(...views.map(item=>item.length))-1;
}
function filterSamples(){
  const terms=el("search").value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const k=el("k").value;
  filtered=manifest.samples.filter(sample=>
    (k==="compare"?sample.k>=2:!k||sample.k===Number(k))&&terms.every(term=>sample.search.includes(term)));
  const previous=selected?.id||decodeURIComponent(location.hash.slice(1));
  el("sample").replaceChildren();
  for(const [index,sample] of filtered.entries()){
    const option=document.createElement("option");
    option.value=sample.id;option.textContent=simpleComparison()?"Example "+(index+1):sample.id+" / k="+sample.k;el("sample").append(option);
  }
  el("sample").disabled=!filtered.length;
  if(!filtered.length){
    selection++;loadController?.abort();selected=null;clearViews();
    el("summary").textContent="No matching samples.";el("count").textContent="0 samples";
    updateVoting("No complete comparisons match your search.");
    el("prev").disabled=true;el("next").disabled=true;return;
  }
  showSample(filtered.some(sample=>sample.id===previous)?previous:filtered[0].id).catch(report);
}
async function showSample(id){
  const sample=filtered.find(item=>item.id===id);if(!sample)return;
  const token=++selection;loadController?.abort();loadController=new AbortController();
  selected=sample;frame=0;lastTime=null;clearViews();el("error").hidden=true;
  if(participantStudy){playing=true;el("play").textContent="Pause";}
  voteChoice=null;updateVoting();
  el("sample").value=id;
  const index=filtered.indexOf(sample);
  el("prev").disabled=index===0;el("next").disabled=index===filtered.length-1;
  el("count").textContent=(index+1)+" / "+filtered.length;
  history.replaceState(null,"","#"+encodeURIComponent(id));
  el("summary").textContent=participantStudy||simpleComparison()?"Loading comparison...":"Loading "+id+"...";
  let data;
  try{data=await getJSON(sample.url,loadController.signal);}
  catch(error){if(error.name==="AbortError")return;throw error;}
  if(token!==selection)return;
  if(data.id!==id)throw new Error("Sample ID mismatch");
  if(voting)voteChoice=participantStudy?.choiceFor?.(id,data.choice)??data.choice;
  el("panes").style.setProperty("--pane-count",data.sources.length+2);
  el("panes").style.setProperty("--pane-rows",Math.ceil((data.sources.length+2)/2));
  const lines=[];
  const characters=[];
  for(const [index,source] of data.sources.entries()){
    const parts=source.parts.join(", ").replaceAll("_"," ");
    const view=makeView(participantStudy?"Source "+(index+1)+": "+parts:simpleComparison()?"Input "+(index+1):source.label,
      simpleComparison()?"":parts,source.mask);
    if(manifest.render_mode==="mixamo"){
      characters.push(installCharacter(view,source.glb,source.length,token));
    }else installFrames(view,source.frames);
    lines.push(source.label+": "+source.length+" frames; "+source.parts.join(", "));
  }
  for(const model of voting?["a","b"]:["motionfuse",baselineKey()]){
    const view=makeView(voting?"Output "+model.toUpperCase():model==="motionfuse"?"MotionFuse":baselineName(),
      voting?"Anonymous candidate":simpleComparison()?"":manifest[model+"_label"]);
    view.model=model;view.url=data.outputs[model];
    if(!view.url)view.pending.textContent=simpleComparison()?"Not available":"Not run for k="+sample.k;
  }
  el("summary").textContent=participantStudy?
    "Prompt: "+data.control_text+"\nLength: "+data.sources[0].length+
      " frames ("+(data.sources[0].length/20).toFixed(2)+" s at 20 fps)":
    voting?"Prompt: "+data.control_text+"\n"+lines.join("\n"):
      lines.join("\n")+"\n"+data.control_text;
  if(simpleComparison()){
    const length=data.target_length??data.sources[0]?.length;
    const fps=data.fps??20;
    el("summary").textContent="Length: "+length+" frames ("+(length/fps).toFixed(1)+" seconds)\n\nPrompt:\n"+data.control_text;
  }
  resetCameras();
  await Promise.all([...characters,loadReadyOutputs(token)]);
  if(token===selection)updateVoting();
}
async function loadReadyOutputs(token=selection){
  if(!selected||(!voting&&!status))return;
  const id=selected.id;
  await Promise.all(views.filter(view=>view.model&&view.url&&!view.frames&&!view.character&&!view.loading).map(async view=>{
    if(!voting&&!status[view.model+"_ready_ids"].includes(id))return;
    view.loading=true;
    try{
      const data=await getJSON(view.url);
      if(token!==selection)return;
      if(data.id!==id)throw new Error("Output ID mismatch for "+id);
      if(manifest.render_mode==="mixamo")await installCharacter(view,data.glb,data.length,token);
      else installFrames(view,data.frames);
    }catch(error){
      if(token===selection){view.pending.textContent="Output failed: "+error.message;report(error);}
    }finally{view.loading=false;}
  }));
  if(token===selection)updateVoting();
}
async function refreshStatus(){
  try{
    const current=await getJSON("status.json");
    const baseline=baselineKey();
    if(!Array.isArray(current.motionfuse_ready_ids)||!Array.isArray(current[baseline+"_ready_ids"])){
      throw new Error("Invalid comparison status");
    }
    status=current;
    el("progress").textContent="MotionFuse "+status.motionfuse_ready_ids.length+"/"+status.expected_motionfuse+
      " | "+baselineName()+" "+status[baseline+"_ready_ids"].length+"/"+status["expected_"+baseline];
    await loadReadyOutputs();
  }catch(error){report(error);}
}
function drawFrame(){
  const maximum=Math.max(1,...views.map(view=>view.length));
  const current=Math.floor(frame)%maximum;
  for(const view of views){
    const local=Math.floor(frame)%view.length;
    if(view.character){
      view.action.time=Math.min((local+1)/20,view.action.getClip().duration-1e-6);
      view.mixer.update(0);view.character.position.set(0,0,0);view.character.updateMatrixWorld(true);
      const root=view.pelvis.getWorldPosition(new THREE.Vector3());
      if(el("center").checked)view.character.position.set(-root.x,1-root.y,-root.z);
      else view.character.position.set(-view.initialRoot.x,-view.floor,-view.initialRoot.z);
      const x=root.x+view.character.position.x,z=root.z+view.character.position.z;
      view.light.position.set(x+3,6,z+4);view.light.target.position.set(x,0,z);
      view.counter.textContent=(local+1)+" / "+view.length;
      continue;
    }
    if(!view.frames)continue;
    const pose=view.frames[local],root=pose[0];
    const center=el("center").checked;
    const points=pose.map(joint=>new THREE.Vector3(
      joint[0]-(center?root[0]:0),joint[1]-(center?root[1]-1:0),joint[2]-(center?root[2]:0)));
    view.joints.forEach((joint,i)=>joint.position.copy(points[i]));
    for(const {bone,a,b} of view.bones){
      const length=points[a].distanceTo(points[b]);bone.visible=length>1e-6;
      if(!bone.visible)continue;
      bone.position.copy(points[a]).lerp(points[b],.5);bone.scale.y=length;
      bone.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),points[b].clone().sub(points[a]).normalize());
    }
    view.counter.textContent=(local+1)+" / "+view.frames.length;
  }
  el("timeline").value=current;el("time").textContent=(current+1)+" / "+maximum;
}
function animate(time){
  requestAnimationFrame(animate);
  if(playing&&lastTime!==null)frame+=(time-lastTime)*20*Number(el("speed").value)/1000;
  lastTime=time;drawFrame();
  const canvas=el("canvas"),rect=canvas.getBoundingClientRect(),width=canvas.clientWidth,height=canvas.clientHeight;
  if(!width||!height)return;
  if(canvas.width!==Math.floor(width*renderer.getPixelRatio())||canvas.height!==Math.floor(height*renderer.getPixelRatio())){
    renderer.setSize(width,height,false);
  }
  renderer.setViewport(0,0,width,height);renderer.setScissor(0,0,width,height);renderer.clear();
  for(const view of views){
    view.controls.update();
    const bounds=view.panel.getBoundingClientRect();
    if(!bounds.width||!bounds.height)continue;
    view.camera.aspect=bounds.width/bounds.height;view.camera.updateProjectionMatrix();
    renderer.setViewport(bounds.left-rect.left,height-(bounds.bottom-rect.top),bounds.width,bounds.height);
    renderer.setScissor(bounds.left-rect.left,height-(bounds.bottom-rect.top),bounds.width,bounds.height);
    renderer.render(view.scene,view.camera);
  }
}
el("play").onclick=()=>{playing=!playing;el("play").textContent=playing?"Pause":"Play";lastTime=null;};
el("timeline").oninput=()=>{playing=false;el("play").textContent="Play";frame=Number(el("timeline").value);drawFrame();};
el("highlight").onchange=()=>views.forEach(colors);
el("reset").onclick=resetCameras;
el("sync").onchange=()=>{if(views.length)linkCamera(views[0]);};
el("search").oninput=filterSamples;el("k").onchange=filterSamples;
el("sample").onchange=()=>showSample(el("sample").value).catch(report);
el("prev").onclick=()=>showSample(filtered[el("sample").selectedIndex-1]?.id).catch(report);
el("next").onclick=()=>showSample(filtered[el("sample").selectedIndex+1]?.id).catch(report);
if(voting)document.querySelectorAll("[data-choice]").forEach(button=>{
  button.onclick=async()=>{
    if(voteSaving||!selected)return;
    const id=selected.id,token=selection;
    voteSaving=true;updateVoting(participantStudy?.saveVote?"Storing vote on this device...":"Saving vote...");
    try{
      const saved=await saveVote(id,button.dataset.choice);
      if(token===selection){
        voteChoice=saved.choice;
        if(participantStudy){
          const next=participantStudy.onSaved(saved.session);
          if(next)await showSample(next);
          else{selected=null;playing=false;clearViews();}
        }
      }
    }catch(error){if(token===selection)report(error);}
    finally{voteSaving=false;if(token===selection)updateVoting(el("error").hidden?null:"Vote not saved. Please retry.");else updateVoting();}
  };
});
window.addEventListener("hashchange",()=>{
  const id=decodeURIComponent(location.hash.slice(1));
  if(id!==selected?.id)showSample(id).catch(report);
});
async function start(){
  manifest=await getJSON(voting?"/api/vote/manifest":"manifest.json");
  if(voting){
    for(const option of el("k").options){
      if(!option.value)continue;
      const count=manifest.source_counts?.[option.value]??
        manifest.samples.filter(sample=>sample.k===Number(option.value)).length;
      option.disabled=count===0;
      option.textContent="k="+option.value+" ("+count+(count?" samples":" - awaiting predictions")+")";
    }
  }
  el("settings").textContent=participantStudy||simpleComparison()?"":manifest.notes;
  el("settings").hidden=Boolean(participantStudy)||simpleComparison();
  if(!voting)document.querySelector("h1").textContent="Mbench: inputs / MotionFuse / "+baselineName();
  if(manifest.render_mode==="mixamo"){
    if(!voting){
      document.querySelector("h1").textContent="Mbench / "+manifest.character+": inputs / MotionFuse / "+baselineName();
      document.title="Mbench Mixamo character comparison";
    }
    el("highlight").checked=false;el("highlight").disabled=true;
    el("highlight").parentElement.title="Assigned parts are listed above; mesh highlighting is not available.";
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
  }
  if(simpleComparison()){
    document.querySelector("h1").textContent="MotionFuse / ViMoGen";
    document.title="MotionFuse / ViMoGen comparison";
    el("search").placeholder="Search prompts";
    for(const option of el("k").options){
      option.textContent=option.value==="compare"?"2 or 3 inputs":
        option.value===""?"All examples":option.value==="0"?"Text only":
        option.value+" input"+(option.value==="1"?"":"s");
    }
    el("highlight").parentElement.hidden=true;
  }
  const requested=decodeURIComponent(location.hash.slice(1));
  if(manifest.samples.some(sample=>sample.id===requested&&sample.k<2))el("k").value="";
  filterSamples();
  if(!voting){await refreshStatus();setInterval(refreshStatus,10000);}
  requestAnimationFrame(animate);
}
start().catch(report);
window.__mbenchComparison={get views(){return views;},renderer};
