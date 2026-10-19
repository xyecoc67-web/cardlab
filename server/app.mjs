const JSON_HEADERS = { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' };
function json(value, status=200) { return new Response(JSON.stringify(value), {status, headers:JSON_HEADERS}); }
async function ownerHash(identity) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function testKey(env) { const key=String(env.STRIPE_TEST_SECRET_KEY??'').trim(); return /^(sk|rk)_test_[A-Za-z0-9_]{8,}$/.test(key) ? key : null; }
function validCheckoutUrl(value) { try { const url=new URL(value); return url.protocol==='https:' && url.hostname==='checkout.stripe.com' && !url.username && !url.password; } catch { return false; } }
export function summarizeSession(session) {
  const intent=typeof session.payment_intent==='object' ? session.payment_intent : null;
  const method=typeof intent?.payment_method==='object' ? intent.payment_method : null;
  let result='incomplete';
  if (session.payment_status==='paid' && intent?.status==='succeeded' && intent.livemode===false) result='paid';
  else if(intent?.status==='requires_action') result='authentication_required';
  else if(intent?.last_payment_error) result='declined';
  else if(intent?.status==='processing') result='processing';
  else if(session.status==='expired') result='expired';
  const brand=String(method?.card?.brand??'');
  const last4=String(method?.card?.last4??'');
  return {mode:'test',result,sessionId:session.id,paymentStatus:session.payment_status,brand:/^[a-z_]{1,30}$/.test(brand)?brand:null,last4:/^\d{4}$/.test(last4)?last4:null,amount:100,currency:'usd'};
}

export function createApp(assets, stripeFetch=globalThis.fetch) {
  const buckets=new Map();
  function rateLimited(owner, create) {
    const now=Date.now(), minute=Math.floor(now/60000);
    const bucket=buckets.get(owner);
    const next=bucket?.minute===minute ? bucket : {minute, reads:0, creates:0};
    next[create?'creates':'reads']++; buckets.set(owner,next);
    if(buckets.size>1000) for(const [key,value]of buckets) if(value.minute<minute-1) buckets.delete(key);
    return next.creates>5 || next.reads>40;
  }
  async function callStripe(path, key, options={}) {
    const headers={Authorization:`Bearer ${key}`,...options.headers};
    if(options.body) headers['Content-Type']='application/x-www-form-urlencoded';
    let response;
    try { response=await stripeFetch(`https://api.stripe.com/v1/${path}`,{...options,headers,signal:AbortSignal.timeout(15000)}); }
    catch { return {error:json({error:'Stripe is temporarily unavailable.'},502)}; }
    let data;
    try { data=await response.json(); } catch { return {error:json({error:'Invalid response from Stripe.'},502)}; }
    if(!response.ok) return {error:json({error:response.status===401||response.status===403?'Check the Stripe test key and its permissions.':'Stripe could not complete this request.'},response.status===429?429:502)};
    return {data};
  }
  return { async fetch(request, env={}) {
    const url=new URL(request.url), path=url.pathname;
    if(path.startsWith('/api/stripe/')) {
      const key=testKey(env), identity=request.headers.get('oai-authenticated-user-id');
      if(path==='/api/stripe/config' && request.method==='GET') return json({configured:!!key,mode:'test',amount:100,currency:'usd',requiresSignIn:!identity});
      if(!key) return json({error:'Set STRIPE_TEST_SECRET_KEY in server secrets. Only test keys are accepted.',code:'not_configured'},503);
      if(!identity) return json({error:'Sign in to start a Stripe test.',code:'sign_in_required',signInUrl:'/signin-with-chatgpt?return_to=%2F'},401);
      const owner=await ownerHash(identity);
      if(path==='/api/stripe/checkout' && request.method==='POST') {
        if(request.headers.get('origin')!==url.origin || request.headers.get('sec-fetch-site')==='cross-site') return json({error:'Origin rejected.'},403);
        if(!request.headers.get('content-type')?.startsWith('application/json')) return json({error:'JSON required.'},415);
        const raw=await request.text(); if(raw.length>512) return json({error:'Request too large.'},413);
        let body; try { body=JSON.parse(raw); } catch { return json({error:'Invalid JSON.'},400); }
        if(!body || Array.isArray(body) || Object.keys(body).some(key=>key!=='requestId') || !/^[a-f0-9-]{36}$/.test(body.requestId??'')) return json({error:'Only a request ID is accepted. Enter payment details on Stripe Checkout.'},400);
        if(rateLimited(owner,true)) return json({error:'Too many test sessions. Try again in a minute.'},429);
        const params=new URLSearchParams({mode:'payment','payment_method_types[0]':'card','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':'100','line_items[0][price_data][product_data][name]':'Cardlab integration test','line_items[0][quantity]':'1',success_url:`${url.origin}/?stripe_session={CHECKOUT_SESSION_ID}`,cancel_url:`${url.origin}/?stripe_cancelled=1`,'metadata[cardlab_owner]':owner,'metadata[purpose]':'cardlab_test','payment_intent_data[metadata][cardlab_owner]':owner});
        const result=await callStripe('checkout/sessions',key,{method:'POST',body:params.toString(),headers:{'Idempotency-Key':`cardlab-${owner}-${body.requestId}`}});
        if(result.error)return result.error;
        const session=result.data;
        if(session.livemode!==false || !/^cs_test_[A-Za-z0-9]+$/.test(session.id??'') || !validCheckoutUrl(session.url)) return json({error:'Expected a Stripe test Checkout Session.'},502);
        return json({mode:'test',checkoutUrl:session.url,sessionId:session.id});
      }
      if(path==='/api/stripe/session' && request.method==='GET') {
        const id=url.searchParams.get('id')??'';
        if(!/^cs_test_[A-Za-z0-9]{5,200}$/.test(id)) return json({error:'Invalid test session ID.'},400);
        if(rateLimited(owner,false)) return json({error:'Too many requests.'},429);
        const result=await callStripe(`checkout/sessions/${id}?expand[]=payment_intent.payment_method`,key,{method:'GET'});
        if(result.error)return result.error;
        const session=result.data;
        if(session.livemode!==false || session.mode!=='payment' || session.amount_total!==100 || session.currency!=='usd' || (typeof session.payment_intent==='object' && session.payment_intent!==null && session.payment_intent.livemode!==false)) return json({error:'Unexpected payment session.'},502);
        if(session.metadata?.cardlab_owner!==owner || session.metadata?.purpose!=='cardlab_test') return json({error:'This session belongs to another test.'},403);
        return json(summarizeSession(session));
      }
      return json({error:'Not found.'},404);
    }
    if(request.method!=='GET'&&request.method!=='HEAD') return new Response('Method not allowed',{status:405});
    const asset=assets[path==='/'?'/index.html':path];
    if(!asset)return new Response('Not found',{status:404});
    return new Response(request.method==='HEAD'?null:asset.body,{headers:{'content-type':asset.type,'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"}});
  }};
}
