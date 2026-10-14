// Draft preview in a sandboxed iframe (srcdoc, sandbox="allow-scripts", own opaque origin): scripts from custom-html blocks
// and raw shop HTML run there without access to the UI and API. Everything the UI needs to do to the draft
// (partial updates while streaming, scroll position, mark mode, numbers) goes through postMessage with this protocol.
// Both sides check the counterpart (event.source) and the marker lotse: 1.

export const FRAME_TAG = 1;

/** UI → draft */
export type ToFrame =
  | { t: 'body'; html: string }            // Partial update: replace only <body> (theme CSS stays, scroll stays)
  | { t: 'scroll'; top: number }           // Restore scroll position after reload
  | { t: 'mark'; on: boolean }             // Mark mode on/off
  | { t: 'pins'; paths: string[] };        // Numbers on the marked elements (CSS paths)
/** Draft → UI */
export type FromFrame =
  | { t: 'scroll'; top: number }
  | { t: 'pick'; tag: string; text: string; alt: string; isButton: boolean; section?: string; path: string; x: number; y: number }
  | { t: 'targets'; items: { tag: string; text: string; alt: string; isButton: boolean; section?: string; path: string }[] };

/** The draft's CSP: AI-written JS must not send anything out (fetch/XHR/sendBeacon/WebSocket, forms);
 *  images, fonts and CSS (via the /shop proxy) still load, scripts still run (needed for custom-html and FRAME_SCRIPT). */
export const FRAME_CSP = "connect-src 'none'; form-action 'none'";
/** Puts the CSP as <meta> at the start of the document (after the doctype, so standards mode stays); it then applies to everything after it */
export function withFrameCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
  const dt = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
  return dt + meta + html.slice(dt.length);
}

/** Check the unique marker (messages from other origins are ignored) */
export const isFrameMessage = (d: unknown): d is { t: string } & Record<string, unknown> => !!d && typeof d === 'object' && (d as { lotse?: unknown }).lotse === FRAME_TAG && typeof (d as { t?: unknown }).t === 'string';

/** Styles for mark mode and numbers (part of the preview document; for the live iframe, annotator.ts injects them) */
export const FRAME_CSS = `.__lotse-hover{outline:2px solid #FF786D!important;outline-offset:2px;cursor:crosshair!important}
.__lotse-pin{position:absolute;z-index:2147483647;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#FF786D;color:#2e2e38;font:700 12px/22px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.25);pointer-events:none}
html.__lotse-on a,html.__lotse-on button{cursor:crosshair!important}`;

/** Meaningful target elements in mark mode: what a human would call "that one" */
export const MEANINGFUL = 'a,button,img,picture,video,h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,table,details,summary,.btn,[class*="button"],label,input,select';

/** Script in the preview document's <head> (plain ES5, no access to parent.document) */
export const FRAME_SCRIPT = `(function(){var P=window.parent;if(!P||P===window)return;var on=false,hov=null,pending=false;
function send(m){m.lotse=${FRAME_TAG};P.postMessage(m,'*')}
function target(el){if(!el||!el.closest)return null;return el.closest(${JSON.stringify(MEANINGFUL)})||el.closest('section,article,.cms-block,.cms-section')||el}
function cssPath(el){var parts=[];for(var e=el;e&&e.tagName!=='BODY'&&parts.length<4;e=e.parentElement){var cls=[];for(var i=0;i<e.classList.length&&cls.length<2;i++){var c=e.classList[i];if(c.indexOf('__lotse')!==0&&!/^aicb-|^css-/.test(c))cls.push('.'+c)}parts.unshift(e.tagName.toLowerCase()+cls.join(''));if(e.tagName==='SECTION')break}return parts.join(' > ')}
function sectionTitle(el){var sec=el.closest('section,.cms-section,article');var h=sec&&sec.querySelector('h1,h2,h3');var t=h&&h.textContent?h.textContent.replace(/\\s+/g,' ').trim():'';return t?(t.length>60?t.slice(0,57)+'\\u2026':t):undefined}
function leave(){if(hov)hov.classList.remove('__lotse-hover');hov=null}
function block(e){if(on){e.preventDefault();e.stopPropagation()}}
document.addEventListener('mouseover',function(e){if(!on)return;var t=target(e.target);if(t===hov)return;leave();hov=t;if(t)t.classList.add('__lotse-hover')},true);
document.addEventListener('mouseleave',function(){if(on)leave()},true);
document.addEventListener('click',function(e){if(!on)return;e.preventDefault();e.stopPropagation();var t=target(e.target);if(!t)return;
var isButton=t.tagName==='BUTTON'||t.classList.contains('btn')||/button/.test(String(t.className));
send({t:'pick',tag:t.tagName,text:String(t.innerText||t.textContent||'').slice(0,300),alt:String(t.alt||'').slice(0,300),isButton:isButton,section:sectionTitle(t),path:cssPath(t),x:e.clientX,y:e.clientY})},true);
document.addEventListener('keydown',function(e){if(!on)return;if(e.key!=='Enter'&&e.key!==' ')return;var t=target(e.target);if(!t)return;e.preventDefault();e.stopPropagation();
var isButton=t.tagName==='BUTTON'||t.classList.contains('btn')||/button/.test(String(t.className));
send({t:'pick',tag:t.tagName,text:String(t.innerText||t.textContent||'').slice(0,300),alt:String(t.alt||'').slice(0,300),isButton:isButton,section:sectionTitle(t),path:cssPath(t),x:0,y:0})},true);
document.addEventListener('focusin',function(e){if(!on)return;var t=target(e.target);if(t===hov)return;leave();hov=t;if(t)t.classList.add('__lotse-hover')},true);
function listTargets(){var els=document.querySelectorAll(${JSON.stringify(MEANINGFUL)});var items=[];for(var i=0;i<els.length&&items.length<40;i++){var t=els[i];if(t.tabIndex<0)t.tabIndex=0;var isButton=t.tagName==='BUTTON'||t.classList.contains('btn')||/button/.test(String(t.className));items.push({tag:t.tagName,text:String(t.innerText||t.textContent||'').slice(0,120),alt:String(t.alt||'').slice(0,120),isButton:isButton,section:sectionTitle(t),path:cssPath(t)})}send({t:'targets',items:items})}
document.addEventListener('submit',block,true);document.addEventListener('auxclick',block,true);
function pins(paths){var old=document.querySelectorAll('.__lotse-pin');for(var i=0;i<old.length;i++)old[i].remove();if(!document.body)return;
for(var n=0;n<paths.length;n++){var el=null;try{el=document.querySelector(paths[n])}catch(e){}if(!el)continue;var r=el.getBoundingClientRect(),pin=document.createElement('span');pin.className='__lotse-pin';pin.textContent=String(n+1);
pin.style.left=Math.max(4,r.left+window.scrollX-8)+'px';pin.style.top=Math.max(4,r.top+window.scrollY-10)+'px';document.body.appendChild(pin)}}
window.addEventListener('scroll',function(){if(pending)return;pending=true;requestAnimationFrame(function(){pending=false;send({t:'scroll',top:window.scrollY})})},{passive:true});
window.addEventListener('message',function(e){if(e.source!==P)return;var d=e.data;if(!d||d.lotse!==${FRAME_TAG})return;
if(d.t==='body'){var y=window.scrollY,atEnd=y>0&&y+window.innerHeight>=document.documentElement.scrollHeight-40;
document.body.innerHTML=new DOMParser().parseFromString(String(d.html),'text/html').body.innerHTML;window.scrollTo({top:atEnd?document.documentElement.scrollHeight:y,behavior:'instant'})}
else if(d.t==='scroll')window.scrollTo({top:Number(d.top)||0,behavior:'instant'});
else if(d.t==='mark'){on=!!d.on;document.documentElement.classList.toggle('__lotse-on',on);if(!on)leave();else listTargets()}
else if(d.t==='pins'){var ps=[];if(Array.isArray(d.paths))for(var k=0;k<d.paths.length;k++)ps.push(String(d.paths[k]));pins(ps)}});
})();`;
