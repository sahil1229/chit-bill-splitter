/// <reference types="vite/client" />

/** Local pixels only. All code/model requests are same-origin static GETs. */
export async function scanPhoto(file:File, signal:AbortSignal, progress:(s:string)=>void):Promise<string>{
 if(file.size>15*1024*1024)throw Error('Choose a photo under 15 MB.');
 if(!/^image\/(jpeg|png|webp)$/i.test(file.type))throw Error('Use a JPEG, PNG or WebP photo. For HEIC, use iPhone Live Text or export a JPEG.');
 let worker:Worker|undefined; let cancelled=false;
 const abort=()=>{cancelled=true;if(worker)void worker.terminate();};signal.addEventListener('abort',abort,{once:true});
 let rejectStop:(e:Error)=>void=()=>{};const stop=new Promise<never>((_,reject)=>{rejectStop=reject;});
 const cancel=()=>rejectStop(Error('Scan cancelled.'));signal.addEventListener('abort',cancel,{once:true});
 const timer=setTimeout(()=>{abort();rejectStop(Error('Scan took too long. Try a smaller, clearer photo or paste the text.'));},60000);
 const work=async()=>{
  if(signal.aborted)throw Error('Scan cancelled.');
  progress('Preparing photo…');
  const url=URL.createObjectURL(file);let image:HTMLImageElement;
  try{image=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('Could not open this photo. Try JPEG or paste the text.'));i.src=url;});}finally{URL.revokeObjectURL(url);}
  if(cancelled)throw Error('Scan cancelled.');
  if(image.naturalWidth*image.naturalHeight>24_000_000)throw Error('This photo is too large. Crop the bill or choose a smaller photo.');
  const scale=Math.min(1,2200/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const ctx=canvas.getContext('2d');if(!ctx)throw Error('Photo scanning is unavailable. Paste text instead.');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  const pixels=canvas.toDataURL('image/png');canvas.width=canvas.height=1;
  const base=new URL(`${import.meta.env.BASE_URL}ocr/`,location.href).href;
  worker=new Worker(base+'worker.min.js');
  let job=0;
  const request=(action:string,payload:unknown)=>new Promise<any>((resolve,reject)=>{
   const jobId=String(++job);const w=worker!;
   const fail=()=>{cleanup();reject(Error('Reader could not load. Check your connection or paste the text.'));};
   const message=(e:MessageEvent)=>{const m=e.data;if(m.status==='progress'){if(!cancelled)progress(m.data?.status==='recognizing text'?`Reading photo: ${Math.round((m.data.progress??0)*100)}%`:'Reading on this device…');return;}if(m.jobId!==jobId)return;cleanup();m.status==='resolve'?resolve(m.data):reject(Error('Could not read this photo. Try a clearer photo or paste text.'));};
   const cleanup=()=>{w.removeEventListener('message',message);w.removeEventListener('error',fail);};
   w.addEventListener('message',message);w.addEventListener('error',fail);w.postMessage({workerId:'chit',jobId,action,payload});
  });
  await request('load',{options:{lstmOnly:true,corePath:base,logging:false}});
  if(cancelled)throw Error('Scan cancelled.');
  await request('loadLanguage',{langs:'eng',options:{langPath:base.slice(0,-1),gzip:true,cacheMethod:'none',lstmOnly:true}});
  await request('initialize',{langs:'eng',oem:1,config:{}});
  if(cancelled){await worker.terminate();throw Error('Scan cancelled.');}
  const bytes=Uint8Array.from(atob(pixels.split(',')[1]),c=>c.charCodeAt(0));
  const result=await request('recognize',{image:bytes,options:{},output:{text:true}});if(cancelled)throw Error('Scan cancelled.');if(!result.text.trim())throw Error('No readable text found. Retake a clear, upright photo or paste text.');return result.text;
 };
 try{return await Promise.race([work(),stop]);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);signal.removeEventListener('abort',cancel);cancelled=true;if(worker)await worker.terminate();}
}
