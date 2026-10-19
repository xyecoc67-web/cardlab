export function mountStripeTest() {
  const button=document.getElementById('stripe-test'), output=document.getElementById('stripe-result');
  let pending=false, requestId=null;
  const show=(message,kind='unknown')=>{output.textContent=message;output.dataset.result=kind;output.hidden=false;};
  async function api(path,options={}) {
    const response=await fetch(path,{...options,credentials:'same-origin',cache:'no-store'});
    let body;try{body=await response.json();}catch{throw new Error('Stripe requires the server version.');}
    if(!response.ok){if(body.code==='sign_in_required'){output.replaceChildren();const link=document.createElement('a');link.href='/signin-with-chatgpt?return_to=%2F';link.target='_top';link.textContent='Sign in to start the Stripe test';output.append(link);output.hidden=false;return null;}throw new Error(body.error??'Stripe request failed.');}
    return body;
  }
  button.addEventListener('click',async()=>{
    if(pending)return;
    if(!['http:','https:'].includes(location.protocol)){show('Stripe requires the server version.');return;}
    pending=true;button.disabled=true;show('Connecting to Stripe…');
    try{
      const config=await api('/api/stripe/config');
      if(!config?.configured)throw new Error('Set STRIPE_TEST_SECRET_KEY in server secrets.');
      requestId??=crypto.randomUUID();
      const session=await api('/api/stripe/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId})});
      if(!session)return;
      const next=new URL(session.checkoutUrl);
      if(next.protocol!=='https:'||next.hostname!=='checkout.stripe.com')throw new Error('Unexpected checkout URL.');
      try{sessionStorage.setItem('cardlab-stripe-session',session.sessionId);}catch{}
      location.assign(next.href);
    }catch(error){show(error.message);}finally{pending=false;button.disabled=false;}
  });
  const params=new URLSearchParams(location.search),cancelled=params.get('stripe_cancelled')==='1';
  let savedId=null;try{savedId=sessionStorage.getItem('cardlab-stripe-session');}catch{}
  const id=params.get('stripe_session')||(cancelled?savedId:null);
  if(cancelled&&!id)show('Stripe test cancelled.');
  if(id){
    show('Verifying Stripe result…');
    api('/api/stripe/session?id='+encodeURIComponent(id)).then(result=>{
      if(!result)return;
      const text={paid:'Payment succeeded',declined:'Payment declined',authentication_required:'Authentication required',processing:'Processing',expired:'Session expired',incomplete:'Payment not completed'}[result.result]??'Payment not completed';
      const names={visa:'Visa',mastercard:'Mastercard',amex:'American Express',discover:'Discover',jcb:'JCB',unionpay:'UnionPay',diners:'Diners Club'};
      const card=result.brand&&result.last4?` · ${names[result.brand]??result.brand} •••• ${result.last4}`:'';
      show((cancelled&&result.result==='incomplete'?'Cancelled':text)+card+' · Stripe test',result.result==='paid'?'valid':result.result==='declined'?'invalid':'unknown');
      if(cancelled||['paid','declined','expired'].includes(result.result))try{sessionStorage.removeItem('cardlab-stripe-session');}catch{}
      if(result.result==='paid')requestId=null;
    }).catch(error=>show(error.message));
  }
  if(id||params.has('stripe_cancelled')){const url=new URL(location.href);url.searchParams.delete('stripe_session');url.searchParams.delete('stripe_cancelled');history.replaceState(null,'',url.pathname+url.search+url.hash);}
}
