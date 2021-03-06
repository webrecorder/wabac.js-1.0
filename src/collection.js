"use strict";

import { Rewriter } from './rewrite';

import { getTS, getSecondsStr, notFound, digestMessage } from './utils.js';

const DEFAULT_CSP = "default-src 'unsafe-eval' 'unsafe-inline' 'self' data: blob: mediastream: ws: wss: ; form-action 'self'";

const REPLAY_REGEX = /^(\d*)([a-z]+_|[$][a-z0-9:.-]+)?(?:\/|\||%7C|%7c)(.+)/;

class Collection {
  constructor(opts) {
    const { name, store, prefix, rootPrefix, staticPrefix, config } = opts;

    this.name = name;
    this.store = store;
    this.config = config;

    this.rootPrefix = rootPrefix || prefix;

    this.prefix = prefix + this.name + "/";

    // support root collection hashtag nav
    if (this.config.root) {
      this.appPrefix = prefix + "#/";
      this.isRoot = true;
    } else {
      this.appPrefix = this.prefix;
      this.isRoot = false;
    }

    this.staticPrefix = staticPrefix;
  }

  async redirectToBlob(request, responseOpts) {
    const acceptDT = request.headers.get('Accept-Datetime');
    const datetime = acceptDT ? new Date(acceptDT) : new Date();
    const requestTS = getTS(datetime.toISOString());

    const blobId = await digestMessage(await request.text(), "SHA-256");

    return Response.redirect(this.prefix + requestTS + '/blob:' + blobId);
  }

  async handleRequest(request, event) {
    let wbUrlStr = request.url;

    if (wbUrlStr.startsWith(this.prefix)) {
      wbUrlStr = wbUrlStr.substring(this.prefix.length);
    } else if (this.isRoot && wbUrlStr.startsWith(this.appPrefix)) {
      wbUrlStr = wbUrlStr.substring(this.appPrefix.length);
    } else {
      return null;
    }

    const responseOpts = {
      "status": 200,
      "statusText": "OK",
      "headers": { "Content-Type": "text/html" }
    };

    let content = null;

    // pageList
    if (wbUrlStr == "") {
      if (request.method === 'POST') {
        return this.redirectToBlob(request, responseOpts);
      }

      content = '<html><body><h2>Available Pages</h2><ul>'

      for (const page of this.store.getAllPages()) {
        let href = this.appPrefix;
        if (page.date) {
          href += page.date + "/";
        }
        href += page.url;
        content += `<li><a href="${href}">${page.url}</a></li>`
      }

      content += '</ul></body></html>'

      return new Response(content, responseOpts);
    }

    const wbUrl = REPLAY_REGEX.exec(wbUrlStr);
    let requestTS = '';
    let requestURL = '';
    let mod = '';

    if (!wbUrl && (wbUrlStr.startsWith("https:") || wbUrlStr.startsWith("http:") || wbUrlStr.startsWith("blob:"))) {
      requestURL = wbUrlStr;
    } else if (!wbUrl) {
      return notFound(request, `Replay URL ${wbUrlStr} not found`);
    } else {
      requestTS = wbUrl[1];
      mod = wbUrl[2];
      requestURL = wbUrl[3];
    }

    // force timestamp for root coll
    if (!requestTS && this.isRoot) {
      requestTS = "2";
    }

    if (!mod) {
      return this.makeTopFrame(requestURL, requestTS);
    }

    const hash = requestURL.indexOf("#");
    if (hash > 0) {
      requestURL = requestURL.substring(0, hash);
    }

    const query = {"url": requestURL,
                   "method": request.method,
                   "request": request,
                   "timestamp": requestTS};

    // exact or fuzzy match
    let response = await this.store.getResource(query, this.prefix, event);

    if (!response) {
      const msg = `<p>Sorry, the URL <b>${requestURL}</b> is not in this archive.</p><p><a href="${requestURL}">Try Live Version?</a></p>`;
      return notFound(request, msg);
    }

    if (!response.noRW) {
      const headInsertFunc = () => {
        const presetCookie = response.headers.get("x-wabac-preset-cookie");
        return this.makeHeadInsert(response.url, requestTS, response.date, presetCookie, response.isLive);
      };

      const rewriter = new Rewriter(response.url, this.prefix + requestTS + mod + "/", headInsertFunc, false, this.config.decode);

      const csp = mod !== "id_" ? DEFAULT_CSP : null;
      const noRewrite = mod === "id_" || mod === "wkrf_";

      response = await rewriter.rewrite(response, request, csp, noRewrite);
    }

    const range = request.headers.get("range");

    if (range && response.status === 200) {
      response.setRange(range);
    }

    return response.makeResponse();
  }

  makeTopFrame(url, requestTS, isLive) {
    const content = `
<!DOCTYPE html>
<html>
<head>
<style>
html, body
{
  height: 100%;
  margin: 0px;
  padding: 0px;
  border: 0px;
  overflow: hidden;
}

</style>
<script src='${this.staticPrefix}/wb_frame.js'> </script>

<script>
window.home = "${this.rootPrefix}";
</script>

<script src='${this.staticPrefix}/default_banner.js'> </script>
<link rel='stylesheet' href='${this.staticPrefix}/default_banner.css'/>

</head>
<body style="margin: 0px; padding: 0px;">
<div id="wb_iframe_div">
<iframe id="replay_iframe" frameborder="0" seamless="seamless" scrolling="yes" class="wb_iframe" allow="autoplay; fullscreen"></iframe>
</div>
<script>
  var cframe = new ContentFrame({"url": "${url}",
                                 "app_prefix": "${this.appPrefix}",
                                 "content_prefix": "${this.prefix}",
                                 "request_ts": "${requestTS}",
                                 "iframe": "#replay_iframe"});

</script>
</body>
</html>
`
    let responseData = {
      "status": 200,
      "statusText": "OK",
      "headers": { "Content-Type": "text/html", "Content-Security-Policy": DEFAULT_CSP }
    };

    return new Response(content, responseData);
  }

  makeHeadInsert(url, requestTS, date, presetCookie, isLive) {

    const topUrl = this.appPrefix + requestTS + (requestTS ? "/" : "") + url;
    const prefix = this.prefix;
    const coll = this.name;

    const seconds = getSecondsStr(date);

    const timestamp = getTS(date.toISOString());

    const urlParsed = new URL(url);

    const scheme = urlParsed.protocol === 'blob:' ? 'https' : urlParsed.protocol.slice(0, -1);

    const presetCookieStr = presetCookie ? JSON.stringify(presetCookie) : '""';
    return `
<!-- WB Insert -->
<style>
body {
  font-family: inherit;
  font-size: inherit;
}
</style>
<script>
  wbinfo = {};
  wbinfo.top_url = "${topUrl}";
  // Fast Top-Frame Redirect
  if (window == window.top && wbinfo.top_url) {
    var loc = window.location.href.replace(window.location.hash, "");
    loc = decodeURI(loc);

    if (loc != decodeURI(wbinfo.top_url)) {
        window.location.href = wbinfo.top_url + window.location.hash;
    }
  }
  wbinfo.url = "${url}";
  wbinfo.timestamp = "${timestamp}";
  wbinfo.request_ts = "${requestTS}";
  wbinfo.prefix = decodeURI("${prefix}");
  wbinfo.mod = "mp_";
  wbinfo.is_framed = true;
  wbinfo.is_live = ${isLive ? 'true' : 'false'};
  wbinfo.coll = "${coll}";
  wbinfo.proxy_magic = "";
  wbinfo.static_prefix = "${this.staticPrefix}/";
  wbinfo.enable_auto_fetch = true;
  wbinfo.presetCookie = ${presetCookieStr};
</script>
<script src='${this.staticPrefix}/wombat.js'> </script>
<script>
  wbinfo.wombat_ts = "${timestamp}";
  wbinfo.wombat_sec = "${seconds}";
  wbinfo.wombat_scheme = "${scheme}";
  wbinfo.wombat_host = "${urlParsed.host}";

  wbinfo.wombat_opts = {};

  if (window && window._WBWombatInit) {
    window._WBWombatInit(wbinfo);
  }
</script>
  `
  }
}

export { Collection };

