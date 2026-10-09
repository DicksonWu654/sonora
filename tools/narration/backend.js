const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');
const readline = require('readline');
const config = require('./config');

function createNarrationBackend({authorize} = {}) {
  let worker = null, state = 'not-installed', serial = 0, startupTimer;
  const pending = new Map(), inflight = new Map();
  const installed = () => fs.existsSync(config.python) && ['config.json','kokoro-v1_0.pth','voices/af_heart.pt','voices/af_bella.pt'].every(f=>fs.existsSync(path.join(config.modelDir,f)));
  function start() {
    if (worker || !installed()) return;
    state = 'loading';
    worker = spawn(config.python, ['-u',path.join(__dirname,'worker.py')], {env:{...process.env,NARRATION_HOME:config.home,NARRATION_DEVICE:config.device},stdio:['pipe','pipe','pipe']});
    const thisWorker = worker;
    startupTimer = setTimeout(()=>{if(state === 'loading') thisWorker.kill();},120000);
    const lines = readline.createInterface({input:worker.stdout});
    lines.on('line',line=>{
      let event; try { event=JSON.parse(line); } catch { return; }
      if(event.event === 'ready') {state='ready';clearTimeout(startupTimer);return;}
      const job = pending.get(event.id);
      if(!job) return;
      pending.delete(event.id); clearTimeout(job.timer);
      if(event.error) job.reject(Object.assign(new Error(event.error),{status:422})); else job.resolve(event.result);
    });
    worker.stderr.on('data',chunk=>process.stderr.write('[narration] '+chunk.toString()));
    const fail = () => {
      if(worker !== thisWorker) return;
      state='error';worker=null;clearTimeout(startupTimer);
      for(const job of pending.values()) {clearTimeout(job.timer);job.reject(Object.assign(new Error('Local voice stopped; the saved job can be retried.'),{status:503}));}
      pending.clear();
    };
    worker.on('error',fail);worker.on('exit',fail);
    worker.stdin.on('error',()=>{});
  }
  if(installed()) start();
  function json(res,status,body) {
    const data=JSON.stringify(body);
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(data),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
  }
  function sameOrigin(req) {
    const remote=req.socket.remoteAddress || '';
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)) return false;
    let host;
    try {host=new URL('http://'+req.headers.host);}catch{return false;}
    if(!['127.0.0.1','localhost','[::1]'].includes(host.hostname)) return false;
    if(req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) return false;
    if(req.headers.origin && req.headers.origin !== host.origin) return false;
    return true;
  }
  function keyFor(text,voice) {return crypto.createHash('sha256').update(JSON.stringify([config.engineVersion,config.revision,voice,text])).digest('hex');}
  async function readCache(key,text,voice) {
    let file;
    try {
      const data=JSON.parse(await fs.promises.readFile(path.join(config.cacheDir,key+'.json'),'utf8'));
      file=await fs.promises.open(path.join(config.cacheDir,key+'.wav'),'r');
      const stat=await file.stat(),header=Buffer.alloc(44);
      const {bytesRead}=await file.read(header,0,44,0);
      if(bytesRead!==44||stat.size<=44||header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,16)!=='WAVEfmt '||header.toString('ascii',36,40)!=='data'||header.readUInt32LE(4)!==stat.size-8||header.readUInt32LE(40)!==stat.size-44||header.readUInt16LE(20)!==1||header.readUInt16LE(22)!==1||header.readUInt32LE(24)!==24000||header.readUInt16LE(34)!==16)return null;
      const duration=(stat.size-44)/48000;
      if(data.voice!==voice||data.audioUrl!=='/api/narration/audio/'+key+'.wav'||!Number.isFinite(data.duration)||Math.abs(data.duration-duration)>.001||!Array.isArray(data.words))return null;
      let last=-1;
      for(const word of data.words){
        if(!word||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.start<last||word.end<=word.start||word.end>duration||!Number.isInteger(word.textOffset)||!Number.isInteger(word.length)||word.textOffset<0||word.length<=0||word.textOffset+word.length>text.length)return null;
        last=word.start;
      }
      return {...data,cached:true};
    }catch{return null;}finally{await file?.close();}
  }
  async function generate(text,voice) {
    const key=keyFor(text,voice);
    // Cache hits remain usable even when the model has not warmed up.
    const cached=await readCache(key,text,voice);
    if(cached)return cached;
    if(!worker && installed()) start();
    if(state !== 'ready') throw Object.assign(new Error(!installed()?'Install the local voice with npm run voice:setup.':'The local voice is still warming up. Please try again in a moment.'),{status:503});
    if(inflight.has(key)) return inflight.get(key);
    if(pending.size >= 6) throw Object.assign(new Error('The local voice queue is full. Please wait for the current passage.'),{status:429});
    const promise=new Promise((resolve,reject)=>{
      const id=++serial;
      const timer=setTimeout(()=>{if(pending.has(id)){worker?.kill();}},180000);
      pending.set(id,{resolve,reject,timer});
      worker.stdin.write(JSON.stringify({id,text,voice})+'\n');
    });
    inflight.set(key,promise);
    try{return await promise;}finally{inflight.delete(key);}
  }
  function serveAudio(req,res,pathname) {
    const match=/^\/api\/narration\/audio\/([a-f0-9]{64})\.wav$/.exec(pathname);
    if(!match){json(res,404,{error:'Audio not found.'});return;}
    const file=path.join(config.cacheDir,match[1]+'.wav');
    fs.stat(file,(error,stat)=>{
      if(error || !stat.isFile()){json(res,404,{error:'Audio not found.'});return;}
      let start=0,end=stat.size-1,status=200;
      if(req.headers.range){
        const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if(!range || (!range[1]&&!range[2])) {res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}
        if(!range[1]) start=Math.max(0,stat.size-Number(range[2]));
        else {start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size) {res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}
        status=206;
      }
      const headers={'Content-Type':'audio/wav','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'};
      if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
      res.writeHead(status,headers);
      if(req.method==='HEAD')return res.end();
      fs.createReadStream(file,{start,end}).on('error',()=>res.destroy()).pipe(res);
    });
  }
  async function handle(req,res,pathname) {
    if(!pathname.startsWith('/api/narration/'))return false;
    // The local inference service is never exposed to another host or website.
    if(!(authorize ? authorize(req) : sameOrigin(req))){json(res,403,{error:'Open your private studio link to use narration.'});return true;}
    if(pathname==='/api/narration/status' && req.method==='GET') {
      if(!worker&&installed())start();
      json(res,200,{ready:state==='ready',state,voices:config.voices,engine:'Kokoro · local neural voice',message:state==='ready'?'Ready':state==='loading'?'Warming up the local voice…':state==='not-installed'?'Run npm run voice:setup, then restart Sonora.':'The local voice could not start. Check the server log and restart.',maxCharacters:4000});return true;
    }
    if(pathname.startsWith('/api/narration/audio/') && ['GET','HEAD'].includes(req.method)){serveAudio(req,res,pathname);return true;}
    if(pathname==='/api/narration/render' && req.method==='POST') {
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){json(res,415,{error:'Send JSON lesson text.'});return true;}
      try {
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>24000){json(res,413,{error:'Passage is too long.'});return true;}chunks.push(chunk);}
        let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(res,400,{error:'Invalid JSON.'});return true;}
        if(!input||typeof input!=='object'||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(input.text)){json(res,400,{error:'Provide between 1 and 4000 characters of readable text.'});return true;}
        const voice=input.voice||'af_heart';
        if(!config.voices.some(v=>v.id===voice)){json(res,400,{error:'Unknown local voice.'});return true;}
        const result=await generate(input.text,voice);
        if(!res.destroyed)json(res,200,result);
      }catch(error){if(!res.destroyed)json(res,error.status||500,{error:error.status?error.message:'Could not render this passage.'});}
      return true;
    }
    json(res,404,{error:'Narration endpoint not found.'});return true;
  }
  return {handle,generate,status(){if(!worker&&installed())start();return {ready:state==='ready',state,installed:installed()};},close(){clearTimeout(startupTimer);worker?.kill();}};
}
module.exports={createNarrationBackend};
