import init, {Engine} from '../dist/yubi_engine.js';

let engine, failed=false;
const ready = (async () => {
  const [bundle] = await Promise.all([
    fetch(new URL('../dist/bundle.json', import.meta.url)).then(r => {
      if (!r.ok) throw new Error(`Bundle load failed (${r.status})`);
      return r.text();
    }),
    init(),
  ]);
  engine = new Engine(bundle);
})();
ready.then(() => postMessage({type:'ready'}), error => postMessage({type:'init-error',message:String(error.message || error)}));

const methods = Object.freeze({
  '/api/search':'search', '/api/normalize':'normalize',
  '/api/refresh-schedule':'refresh_schedule', '/api/display-schedule':'display_schedule',
  '/api/catalog':'catalog_json', '/api/action-lanes':'action_lanes_json',
  '/api/label-tasks':'label_tasks_json',
});
self.onmessage = async ({data:{id,path,payload}}) => {
  try {
    if(failed)return;
    await ready;
    const method = methods[path];
    if (!method) throw new Error('Unsupported engine endpoint');
    const body = path === '/api/catalog' || path === '/api/action-lanes' || path === '/api/label-tasks'
      ? engine[method]() : engine[method](JSON.stringify(payload));
    postMessage({id,status:200,body});
  } catch(error) {
    if(error instanceof WebAssembly.RuntimeError || error instanceof RangeError){
      failed=true;
      postMessage({type:"fatal",message:String(error.message || error)});
      self.close();
      return;
    }
    // A computation error is returned to the UI, never silently rerun on HTTP.
    postMessage({id,status:400,body:JSON.stringify({error:String(error.message || error)})});
  }
};
