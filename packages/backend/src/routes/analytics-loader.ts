// Public loader builder: returns the JS string that injects analytics tags
// plus the first-party event pipeline. Extracted verbatim from analytics.ts;
// this module is large because of the embedded browser snippet template
// literals.

import {
  type AnalyticsRow,
  CF_TOKEN_RE,
  CUSTOM_HEAD_MAX,
  DOMAIN_RE,
  GA4_RE,
} from './analytics-shared.js';

export function buildLoaderJs(
  row: AnalyticsRow | null,
  appId: string,
  apiBase = 'https://api.proappstore.online',
): string {
  const parts: string[] = [];
  if (row?.cf_beacon_token && CF_TOKEN_RE.test(row.cf_beacon_token)) {
    parts.push(
      `_pasAnalytics.script("https://static.cloudflareinsights.com/beacon.min.js",{defer:true,"data-cf-beacon":${JSON.stringify(JSON.stringify({ token: row.cf_beacon_token }))}});`,
    );
  }
  if (row?.ga4 && GA4_RE.test(row.ga4)) {
    const id = JSON.stringify(row.ga4);
    parts.push(
      `_pasAnalytics.script("https://www.googletagmanager.com/gtag/js?id="+${id},{async:true});`,
      `_pasAnalytics.inline("window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config',"+${id}+");");`,
    );
  }
  if (row?.plausible && DOMAIN_RE.test(row.plausible)) {
    const domain = JSON.stringify(row.plausible);
    parts.push(
      `_pasAnalytics.script("https://plausible.io/js/script.js",{defer:true,"data-domain":${domain}});`,
    );
  }
  if (row?.custom_head && row.custom_head.length <= CUSTOM_HEAD_MAX) {
    parts.push(`_pasAnalytics.raw(${JSON.stringify(row.custom_head)});`);
  }
  // First-party event pipeline with IndexedDB offline buffer + drain-on-reconnect.
  // Each event carries client-recorded timestamp so replayed events land on
  // the right day in the dashboard.
  const beaconBase = JSON.stringify(apiBase);
  const idLit = JSON.stringify(appId);
  parts.push(`(function(){
    var URL = ${beaconBase}+"/v1/analytics/event";
    var APP = ${idLit};
    var DB_NAME = "pasA", STORE = "outbox", MAX_BUFFER = 200;
    function openDB(){
      return new Promise(function(res, rej){
        try{
          var r = indexedDB.open(DB_NAME, 1);
          r.onupgradeneeded = function(e){ e.target.result.createObjectStore(STORE,{keyPath:"id",autoIncrement:true}); };
          r.onsuccess = function(){ res(r.result); };
          r.onerror = function(){ rej(); };
        }catch(e){ rej(); }
      });
    }
    function buffer(evt){
      openDB().then(function(db){
        try{
          var tx = db.transaction(STORE, "readwrite");
          var s = tx.objectStore(STORE);
          var c = s.count();
          c.onsuccess = function(){ if (c.result < MAX_BUFFER) s.add(evt); };
        }catch(e){}
      }).catch(function(){});
    }
    function postBatch(events){
      if (!events.length) return Promise.resolve(true);
      var body = JSON.stringify({events: events});
      if (navigator.sendBeacon && navigator.sendBeacon(URL, body)) return Promise.resolve(true);
      return fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true})
        .then(function(r){ return r.ok; }).catch(function(){ return false; });
    }
    function drain(){
      openDB().then(function(db){
        try{
          var tx = db.transaction(STORE, "readwrite");
          var s = tx.objectStore(STORE);
          var req = s.getAll();
          req.onsuccess = function(){
            var rows = req.result || [];
            if (!rows.length) return;
            postBatch(rows.map(function(r){ return r.evt; })).then(function(ok){
              if (!ok) return;
              var tx2 = db.transaction(STORE, "readwrite");
              tx2.objectStore(STORE).clear();
            });
          };
        }catch(e){}
      }).catch(function(){});
    }
    function send(kind, props){
      var evt = {app:APP,kind:kind,path:location.pathname,referrer:document.referrer,props:props||null,t:Date.now()};
      if (navigator.onLine === false) { buffer(evt); return; }
      try{
        var body = JSON.stringify(evt);
        var ok = navigator.sendBeacon ? navigator.sendBeacon(URL, body) : false;
        if (!ok) {
          fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true})
            .catch(function(){ buffer(evt); });
        }
      }catch(e){ buffer(evt); }
    }
    send("pageview");
    drain();
    window.addEventListener("online", drain);
    window.pasAnalytics = window.pasAnalytics || {};
    window.pasAnalytics.event = function(kind, props){ send(String(kind||"event"), props); };
    var _push = history.pushState, _replace = history.replaceState;
    history.pushState = function(){ _push.apply(this, arguments); send("pageview"); };
    history.replaceState = function(){ _replace.apply(this, arguments); send("pageview"); };
    window.addEventListener("popstate", function(){ send("pageview"); });
  })();`);
  return `(function(){
  var _pasAnalytics = {
    script: function(src, attrs){
      var s = document.createElement("script");
      s.src = src;
      for (var k in attrs) { if (attrs[k] === true) s.setAttribute(k,""); else s.setAttribute(k, attrs[k]); }
      document.head.appendChild(s);
    },
    inline: function(code){
      var s = document.createElement("script");
      s.text = code;
      document.head.appendChild(s);
    },
    raw: function(html){
      var t = document.createElement("template");
      t.innerHTML = html;
      while (t.content.firstChild) document.head.appendChild(t.content.firstChild);
    }
  };
  ${parts.join('\n  ')}
})();
`;
}
