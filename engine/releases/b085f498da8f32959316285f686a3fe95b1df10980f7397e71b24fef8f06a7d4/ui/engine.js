/** Fetch-compatible, opt-in adapter. The existing UI is not modified.
 * const apiFetch = await createEngineFetch({mode:'wasm'});
 * const response = await apiFetch('/api/search', {method:'POST', body:JSON.stringify({alg})});
 * Browser-only inference. HTTP inference and fallback are disabled.
 */
const endpoints = new Map([
  ['/api/search','POST'],['/api/normalize','POST'],['/api/refresh-schedule','POST'],
  ['/api/display-schedule','POST'],['/api/catalog','GET'],['/api/action-lanes','GET'],['/api/label-tasks','GET'],
]);

// WebViews that cannot start module Workers can still run the same WASM locally.
export async function createLocalEngineWorker() {
  const {default:init,Engine}=await import('../dist/yubi_engine.js');
  const [bundle]=await Promise.all([
    fetch(new URL('../dist/bundle.json',import.meta.url)).then(r=>{
      if(!r.ok)throw new Error(`Bundle load failed (${r.status})`);
      return r.text();
    }), init(),
  ]);
  const engine=new Engine(bundle);
  const methods={'/api/search':'search','/api/normalize':'normalize',
    '/api/refresh-schedule':'refresh_schedule','/api/display-schedule':'display_schedule',
    '/api/catalog':'catalog_json','/api/action-lanes':'action_lanes_json','/api/label-tasks':'label_tasks_json'};
  let closed=false;
  return {
    postMessage({id,path,payload}) {
      // Yield before synchronous inference so the UI can show its busy state.
      setTimeout(()=>{
        if(closed)return;
        let data;
        try {
          const method=methods[path];
          if(!method)throw new Error('Unsupported engine endpoint');
          const body=endpoints.get(path)==='GET'?engine[method]():engine[method](JSON.stringify(payload));
          data={id,status:200,body};
        } catch(error) {
          if(error instanceof WebAssembly.RuntimeError || error instanceof RangeError) {
            closed=true;
            this.onerror?.({message:String(error.message||error)});
            return;
          }
          data={id,status:400,body:JSON.stringify({error:String(error.message||error)})};
        }
        this.onmessage?.({data});
      },0);
    },
    terminate(){if(!closed){closed=true;engine.free();}},
  };
}

export async function createEngineFetch({mode='wasm',fetchImpl=globalThis.fetch.bind(globalThis),WorkerImpl=globalThis.Worker,localEngineFactory=createLocalEngineWorker,startupTimeoutMs=15000}={}) {
  if (mode!=='wasm') throw new TypeError('Only browser WASM inference is supported');
  let worker,sequence=0,disposed=false,execution='worker';
  const pending = new Map();
  try {
    worker = new WorkerImpl(new URL('./engine.worker.js',import.meta.url),{type:'module'});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>fail(new Error('WASM worker startup timed out')),startupTimeoutMs);
      const succeed=()=>{clearTimeout(timer);resolve();};
      const fail=error=>{clearTimeout(timer);reject(error);};
      worker.onmessage = ({data}) => {
        if (data.type==='ready') succeed();
        if (data.type==='init-error') fail(new Error(data.message));
      };
      worker.onerror = e => fail(new Error(e.message || 'WASM worker failed to initialize'));
    });
  } catch(error) {
    worker?.terminate();
    try {worker=await localEngineFactory();execution='main-thread';}
    catch(localError) {
      const reason=`Worker: ${error.message}; browser WASM: ${localError.message}`;
      throw new Error(reason);
    }
  }
  const stop = error => {
    if(disposed)return;
    disposed=true;
    for(const item of pending.values()){item.cleanup();item.reject(error);}
    pending.clear();
    try{worker.terminate();}catch{/* A trapped local WASM instance cannot be freed safely. */}
  };
  worker.onmessage = ({data}) => {
    if(data.type==='fatal'){stop(new Error(data.message || 'WASM engine trapped'));return;}
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);item.cleanup();
    try{item.resolve(new Response(data.body,{status:data.status,headers:{'content-type':'application/json; charset=utf-8'}}));}
    catch(error){item.reject(error);}
  };
  worker.onerror = e => stop(new Error(e.message || 'WASM worker failed'));
  worker.onmessageerror = () => stop(new Error('WASM worker message could not be decoded'));
  const apiFetch = async (input,options={}) => {
    const request=input instanceof Request?input:null;
    const url = new URL(request?.url || String(input), globalThis.location?.href || 'http://localhost/');
    const method=(options.method || request?.method || 'GET').toUpperCase();
    const origin=globalThis.location?.origin || 'http://localhost';
    if (!url.pathname.startsWith('/api/')) return fetchImpl(input,options);
    if (url.origin!==origin || endpoints.get(url.pathname)!==method) return new Response(JSON.stringify({error:'Server API requests are disabled'}),{status:400,headers:{'content-type':'application/json'}});
    if (disposed) throw new Error('Engine has been disposed');
    const signal=options.signal || request?.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted','AbortError');
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      const cleanup=()=>signal?.removeEventListener('abort',abort);
      const abort=()=>{pending.delete(id);cleanup();reject(new DOMException('The operation was aborted','AbortError'));};
      const finish=(value,error=false)=>{
        if(!pending.has(id))return;
        pending.delete(id);cleanup();
        if(error)reject(value);else resolve(value);
      };
      // Register before reading a Request body: dispose/abort/error must settle
      // the caller even if its stream never produces another byte.
      pending.set(id,{resolve,reject,cleanup});
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      (async()=>{
        let payload;
        if(method==='POST'){
          const body=options.body ?? (request?await request.clone().text():'');
          if(disposed || !pending.has(id))return;
          try{payload=JSON.parse(body);}catch{
            finish(new Response(JSON.stringify({error:'Invalid JSON'}),{status:400,headers:{'content-type':'application/json'}}));return;
          }
        }
        if(disposed || !pending.has(id))return;
        worker.postMessage({id,path:url.pathname,payload});
      })().catch(error=>finish(error,true));
    });
  };
  Object.assign(apiFetch,{backend:'wasm',execution,dispose(){stop(new Error('Engine has been disposed'));}});
  Object.defineProperty(apiFetch,'disposed',{get:()=>disposed});
  return apiFetch;
}
