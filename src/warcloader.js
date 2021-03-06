import { makeHeaders, tsToDate } from './utils.js';

import { WARCParser } from 'warcio';


// ===========================================================================
class WARCLoader {
  constructor(stream) {
    this.stream = stream;

    this.anyPages = false;

    this._lastRecord = null;

    this.promises = [];
  }

  parseWarcInfo(record) {
    var dec = new TextDecoder("utf-8");
    const text = dec.decode(record.payload);

    // Webrecorder-style metadata
    for (const line of text.split("\n")) {
      if (line.startsWith("json-metadata:")) {
        try {
          const json = JSON.parse(line.slice("json-metadata:".length));

          const pages = json.pages || [];

          for (const page of pages) {
            const url = page.url;
            const title = page.title || page.url;
            const id = page.id;
            const date = tsToDate(page.timestamp).toISOString();
            this.addPage({url, date, title, id});
            this.anyPages = true;
          }

        } catch (e) { }
      }
    }
  }

  addPage(page) {
    this.promises.push(this.db.addPage(page));
  }

  addResource(res) {
    this.promises.push(this.db.addResource(res));
  }

  index(record) {
    if (record.warcType === "warcinfo") {
      this.parseWarcInfo(record);
      return;
    }

    //record.cdx = cdx;

    if (!this._lastRecord) {
      this._lastRecord = record;
      return;
    }

    if (this._lastRecord.warcTargetURI != record.warcTargetURI) {
      this.indexReqResponse(this._lastRecord, null);
      this._lastRecord = record;
      return;
    }

    if (record.warcType === "request" && this._lastRecord.warcType === "response") {
      this.indexReqResponse(this._lastRecord, record);
    } else if (record.warcType === "response" && this._lastRecord.warcType === "request") {
      this.indexReqResponse(record, this._lastRecord);
    }
    this._lastRecord = null;
  }

  indexDone() {
    if (this._lastRecord) {
      this.indexReqResponse(this._lastRecord);
      this._lastRecord = null;
    }
  }

  parseRevisitRecord(record) {
    const url = record.warcTargetURI.split("#")[0];
    const date = record.warcDate;
    const ts = new Date(record.warcDate).getTime();

    const origURL = record.warcRefersToTargetURI;
    const origTS = new Date(record.warcRefersToDate).getTime();

    // self-revisit, skip
    if (origURL === url && origTS === ts) {
      return null;
    }

    const digest = record.warcPayloadDigest;

    return {url, ts, origURL, origTS, digest, pageId: null};
  }

  indexReqResponse(record, reqRecord) {
    const entry = this.parseRecords(record, reqRecord);

    if (entry) {
      this.addResource(entry);
    }
  }

  parseRecords(record, reqRecord) {
    if (record.warcType === "revisit") {
      return this.parseRevisitRecord(record);
    }

    if (record.warcType !== "response" && record.warcType !== "resource") {
      return null;
    }

    if (record.warcType === "resource") {
      reqRecord = null;
    }

    const url = record.warcTargetURI.split("#")[0];
    const date = record.warcDate;

    let headers;
    let status = 200;
    let statusText = "OK";
    //let content = record.content;
    let cl = 0;
    let mime = "";

    if (record.httpInfo) {
      status = Number(record.httpInfo.statusCode) || 200;

      // skip empty responses
      if (status === 204) {
        return null;
      }

      if (reqRecord && reqRecord.httpInfo.method === "OPTIONS") {
        return null;
      }
 
      statusText = record.httpInfo.statusReason;

      headers = makeHeaders(record.httpInfo.headers);

      //if (!reqRecord && !record.content.length &&
      //    (headers.get("access-control-allow-methods") || headers.get("access-control-allow-credentials"))) {
      //  return null;
      //}

      mime = (headers.get("content-type") || "").split(";")[0];

      cl = parseInt(headers.get('content-length') || 0);

      // skip partial responses (not starting from 0)
      if (status === 206) {
        const range = headers.get("content-range");

        const fullRange = `bytes 0-${cl-1}/${cl}`;

        // only include 206 responses if they are the full range
        if (range && range !== fullRange) {
          return null;
        }
      }

      // skip self-redirects
      if (status > 300 && status < 400) {
        const location = headers.get('location');
        if (location) {
          if (new URL(location, url).href === url) {
            return null;
          }
        }
      }
    } else {
      headers = new Headers();
      headers.set("content-type", record.warcContentType);
      headers.set("content-length", record.warcContentLength);
      mime = record.warcContentType;

      cl = record.warcContentLength;
    }

    if (reqRecord && reqRecord.httpInfo.headers) {
      try {
        const reqHeaders = new Headers(reqRecord.httpInfo.headers);
        const cookie = reqHeaders.get("cookie");
        if (cookie) {
          headers.set("x-wabac-preset-cookie", cookie);
        }
      } catch(e) {
        console.warn(e);
      }
    }
/*
    if (cl && content.byteLength !== cl) {
      // expected mismatch due to bug in node-warc occasionally including trailing \r\n in record
      if (cl === content.byteLength - 2) {
        content = content.slice(0, cl);
      } else {
      // otherwise, warn about mismatch
        console.warn(`CL mismatch for ${url}: expected: ${cl}, found: ${content.byteLength}`);
      }
    }
*/
    // if no pages found, start detection if hasn't started already
    if (this.detectPages === undefined) {
      this.detectPages = !this.anyPages;
    }

    if (this.detectPages) {
      if (isPage(url, status, mime)) {
        const title = url;
        this.addPage({url, date, title});
      }
    }

    const ts = new Date(date).getTime();

    const respHeaders = Object.fromEntries(headers.entries());

    const digest = record.warcPayloadDigest;

    const payload = record.payload;
    const stream = payload ? null : record.stream;

    const entry = {url, ts, status, mime, respHeaders, digest, payload, stream}

    if (record.warcHeader("WARC-JSON-Metadata")) {
      try {
        entry.extraOpts = JSON.parse(record.warcHeader("WARC-JSON-Metadata"));
      } catch (e) { }
    }

    return entry;
  }

  async load(db) {
    this.db = db;

    const parser = new WARCParser();

    for await (const record of parser.iterRecords(this.stream)) {
      await record.readFully();
      this.index(record);
    }

    this.indexDone();

    await Promise.all(this.promises);
    this.promises = [];
  }
}


// ===========================================================================
function isPage(url, status, mime) {
  if (status != 200) {
    return false;
  }

  if (!url.startsWith("http:") && !url.startsWith("https:") && !url.startsWith("blob:")) {
    return false;
  }

  if (url.endsWith("/robots.txt")) {
    return false;
  }

  // skip urls with long query
  const parts = url.split("?", 2);

  if (parts.length === 2 && parts[1].length > parts[0].length) {
    return false;
  }

  // skip 'files' starting with '.' from being listed as pages
  if (parts[0].substring(parts[0].lastIndexOf("/") + 1).startsWith(".")) {
    return false;
  }

  if (mime && mime !== "text/html") {
    return false;
  }

  return true;
}




export { WARCLoader, isPage };
