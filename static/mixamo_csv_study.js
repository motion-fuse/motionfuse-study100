const models=["motionfuse","vimogen"];
const prefix="mixamo_csv_session_";

function shuffled(items){
  const result=[...items];
  for(let i=result.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [result[i],result[j]]=[result[j],result[i]];
  }
  return result;
}

export function selectSamples(samples,size=50,fixed=false){
  if(!Number.isInteger(size)||size<1||(!fixed&&(size<2||size%2))){
    throw new Error(fixed?"Session size must be a positive integer.":"Session size must be a positive even number.");
  }
  if(new Set(samples.map(sample=>sample.id)).size!==samples.length)throw new Error("Duplicate comparison IDs.");
  if(fixed){
    if(samples.length!==size)throw new Error("All fixed comparisons must be available; expected "+size+".");
    if(samples.some(sample=>![2,3].includes(sample.k)))throw new Error("Fixed comparisons must use two or three inputs.");
    return shuffled(samples);
  }
  const groups=[2,3].map(k=>shuffled(samples.filter(sample=>sample.k===k)));
  if(groups.some(group=>group.length<size/2))throw new Error("Not enough ready comparisons of each input count.");
  return shuffled(groups.flatMap(group=>group.slice(0,size/2)));
}

function csvCell(value){
  let text=String(value??"");
  if(/^\s*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}

export class CsvStudy {
  constructor(data,storage){
    this.data=data;this.storage=storage;
  }

  static create({catalog,participantId="",storage=localStorage,size=50,fixed=false}){
    const id=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");
    const samples=selectSamples(catalog.samples,size,fixed).map(sample=>({
      ...sample,a_model:models[Math.floor(Math.random()*models.length)],choice:null,voted_at:null,
    }));
    const study=new CsvStudy({
      version:1,id,participant_id:participantId.trim(),created_at:new Date().toISOString(),
      comparison_url:catalog.comparison_url,character:catalog.character,
      character_glb:catalog.character_glb,bones:catalog.bones,samples,
    },storage);
    study.persist(study.data);
    return study;
  }

  static load(id,storage=localStorage){
    const raw=storage.getItem(prefix+id);
    if(!raw)throw new Error("The saved CSV session is unavailable.");
    const data=JSON.parse(raw);
    if(data.version!==1||data.id!==id||!Array.isArray(data.samples)||!data.samples.length){
      throw new Error("The saved CSV session is invalid.");
    }
    return new CsvStudy(data,storage);
  }

  persist(data){
    try{this.storage.setItem(prefix+data.id,JSON.stringify(data));}
    catch{throw new Error("Could not save answers in this browser. Free some browser storage and retry; your vote has not advanced.");}
    this.data=data;
  }

  state(){
    const samples=this.data.samples.map(sample=>({id:sample.id,choice:sample.choice}));
    const answered=samples.filter(sample=>sample.choice!==null).length;
    return {
      participant_id:this.data.participant_id,samples,answered,total:samples.length,
      complete:answered===samples.length,
      next_sample:samples.find(sample=>sample.choice===null)?.id??null,
    };
  }

  recordVote(id,choice){
    if(!["a","b","tie"].includes(choice))throw new Error("Invalid vote.");
    const current=CsvStudy.load(this.data.id,this.storage);
    const state=current.state(),sample=current.data.samples.find(item=>item.id===id);
    if(!sample)throw new Error("This comparison is not part of this session.");
    if(state.complete)throw new Error("This session is complete.");
    if(sample.choice===null&&state.next_sample!==id)throw new Error("Vote on the current comparison first.");
    this.persist({
      ...current.data,
      samples:current.data.samples.map(item=>item.id===id?
        {...item,choice,voted_at:new Date().toISOString()}:item),
    });
    return {saved:true,choice,session:this.state()};
  }

  getJSON(url){
    if(url==="/api/vote/manifest"){
      return {
        render_mode:"mixamo",character:this.data.character,character_glb:this.data.character_glb,
        bones:this.data.bones,notes:"",
        samples:this.data.samples.map(sample=>({
          id:sample.id,k:sample.k,url:"csv:sample/"+encodeURIComponent(sample.id),
        })),
        source_counts:Object.fromEntries([2,3].map(k=>[k,this.data.samples.filter(sample=>sample.k===k).length])),
      };
    }
    const [kind,encoded,slot]=url.split("/");
    const id=decodeURIComponent(encoded||""),sample=this.data.samples.find(item=>item.id===id);
    if(!sample)throw new Error("Comparison not found in this CSV session.");
    if(kind==="csv:sample"){
      return {
        id,k:sample.k,control_text:sample.control_text,choice:sample.choice,sources:sample.sources,
        outputs:Object.fromEntries(["a","b"].map(key=>[key,"csv:output/"+encodeURIComponent(id)+"/"+key])),
      };
    }
    if(kind==="csv:output"&&["a","b"].includes(slot)){
      const model=slot==="a"?sample.a_model:models.find(name=>name!==sample.a_model);
      const output=sample.outputs[model];
      return {id,length:output.length,glb:output.glb};
    }
    throw new Error("Unknown CSV study resource.");
  }

  toCSV(){
    if(!this.state().complete)throw new Error("Finish all comparisons before exporting the CSV.");
    const header=["id","choice"];
    const rows=this.data.samples.map(sample=>[
      sample.id+":"+models.indexOf(sample.a_model),sample.choice,
    ]);
    return "\uFEFF"+[header,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n")+"\r\n";
  }
}
