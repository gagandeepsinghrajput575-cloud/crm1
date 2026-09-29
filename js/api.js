/* =============================================================================
 * Dialflow API client
 *
 * Speaks to the server in server/. Keeps the UI's existing data model intact
 * and translates at the boundary, so none of the rendering code above it has
 * to change shape.
 *
 * Connection is discovered at runtime: same origin first (when the UI is
 * served by a proxy), then localhost:4000. If neither answers, the app falls
 * back to its localStorage cache and keeps working offline.
 * ========================================================================== */
(function (global) {
  'use strict';

  var CANDIDATE_BASE_URLS = [
    '',                                   // same origin (proxied deployments)
    'http://localhost:4000',
    'http://127.0.0.1:4000'
  ];

  var KEY_STORAGE = 'dialflow_api_key';
  var BASE_STORAGE = 'dialflow_api_base';

  function readStored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStored(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private mode — fall back to in-memory only */ }
  }

  function ApiError(message, status, code, details) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status;
    this.code = code;
    this.details = details;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function ApiClient() {
    this.baseUrl = readStored(BASE_STORAGE) || '';
    this.apiKey = readStored(KEY_STORAGE) || '';
    this.online = false;
    this.lastError = null;
  }

  ApiClient.prototype.getKey = function () { return this.apiKey; };

  ApiClient.prototype.setKey = function (key) {
    this.apiKey = key || '';
    writeStored(KEY_STORAGE, this.apiKey);
  };

  /**
   * Probes each candidate base URL with a short timeout. The first one whose
   * /health responds wins. A 401 still counts as "the API is here" — it just
   * means the key is wrong, which is a different problem from "no server".
   */
  ApiClient.prototype.connect = function (timeoutMs) {
    var self = this;
    var candidates = self.baseUrl
      ? [self.baseUrl]
      : CANDIDATE_BASE_URLS.slice();

    return candidates.reduce(function (chain, base) {
      return chain.then(function () {
        return self._probe(base, timeoutMs || 1500).then(function (ok) {
          if (ok) { self.baseUrl = base; writeStored(BASE_STORAGE, base); return true; }
          return false;
        });
      });
    }, Promise.resolve(false)).then(function (found) {
      self.online = !!found;
      return self.online;
    });
  };

  ApiClient.prototype._probe = function (base, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(base + '/health', { signal: controller.signal })
      .then(function (res) { clearTimeout(timer); return res.ok || res.status === 401; })
      .catch(function () { clearTimeout(timer); return false; });
  };

  ApiClient.prototype.request = function (method, path, body) {
    var self = this;
    if (!self.baseUrl) return Promise.reject(new ApiError('API base URL unknown', 0, 'OFFLINE'));

    var headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (self.apiKey) headers['authorization'] = 'Bearer ' + self.apiKey;

    return fetch(self.baseUrl + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }

        if (!res.ok) {
          var err = parsed && parsed.error ? parsed.error : {};
          // A 401 means the server is reachable but the key is wrong. Staying
          // "online" lets the UI keep trying instead of silently degrading to
          // local-only and looking like a successful save.
          self.lastError = err.message || ('HTTP ' + res.status);
          throw new ApiError(err.message || ('HTTP ' + res.status), res.status, err.code, err.details);
        }
        return parsed;
      });
    }, function (netErr) {
      self.online = false;
      self.lastError = netErr && netErr.message;
      throw new ApiError('Network error reaching API', 0, 'OFFLINE', netErr && netErr.message);
    });
  };

  /* ------------------------------------------------------------ endpoints */

  /**
   * Appends a query string only when there is one. `new URLSearchParams({})
   * .toString()` is '', so a naive `'?' + ...` produces a trailing `?` and
   * Fastify then parses `limit=200?` — a silent 422 on a valid request.
   */
  function withQuery(path, params) {
    if (!params) return path;
    var qs = new URLSearchParams(params).toString();
    return qs ? path + '?' + qs : path;
  }

  ApiClient.prototype.listLeads = function (params) {
    return this.request('GET', withQuery('/api/leads', params || { limit: 200 }));
  };
  ApiClient.prototype.getLead = function (id) {
    return this.request('GET', '/api/leads/' + id);
  };
  ApiClient.prototype.createLead = function (lead) {
    return this.request('POST', '/api/leads', lead);
  };
  ApiClient.prototype.updateLead = function (id, patch) {
    return this.request('PATCH', '/api/leads/' + id, patch);
  };
  ApiClient.prototype.deleteLead = function (id) {
    return this.request('DELETE', '/api/leads/' + id);
  };
  ApiClient.prototype.addNote = function (leadId, text) {
    return this.request('POST', '/api/leads/' + leadId + '/notes', { text: text });
  };
  ApiClient.prototype.bulkDelete = function (ids) {
    return this.request('POST', '/api/leads/bulk-delete', { ids: ids });
  };
  ApiClient.prototype.pipeline = function () {
    return this.request('GET', '/api/pipeline');
  };
  ApiClient.prototype.moveLead = function (leadId, toStage) {
    return this.request('POST', '/api/pipeline/move', { leadId: leadId, toStage: toStage });
  };
  ApiClient.prototype.listCalls = function (params) {
    return this.request('GET', withQuery('/api/calls', params || { limit: 200 }));
  };
  ApiClient.prototype.dial = function (leadId, mode) {
    return this.request('POST', '/api/calls', { leadId: leadId, mode: mode });
  };
  ApiClient.prototype.completeCall = function (callId, payload) {
    return this.request('POST', '/api/calls/' + callId + '/complete', payload);
  };
  ApiClient.prototype.hangup = function (callId) {
    return this.request('POST', '/api/calls/' + callId + '/hangup', {});
  };
  ApiClient.prototype.simulate = function (callId) {
    return this.request('POST', '/api/calls/' + callId + '/simulate', {});
  };
  ApiClient.prototype.previewImport = function (csv) {
    return this.request('POST', '/api/imports/preview', { csv: csv, limit: 25 });
  };
  ApiClient.prototype.importLeads = function (csv, opts) {
    return this.request('POST', '/api/imports/leads', {
      csv: csv,
      filename: (opts && opts.filename) || 'import.csv',
      updateExisting: !!(opts && opts.updateExisting)
    });
  };
  ApiClient.prototype.summary = function (days) {
    return this.request('GET', '/api/analytics/summary?days=' + (days || 30));
  };
  ApiClient.prototype.getSettings = function () {
    return this.request('GET', '/api/settings');
  };
  ApiClient.prototype.patchSettings = function (patch) {
    return this.request('PATCH', '/api/settings', patch);
  };
  ApiClient.prototype.verifyTelephony = function () {
    return this.request('POST', '/api/settings/telephony/verify', {});
  };

  global.DialflowApi = {
    ApiClient: ApiClient,
    ApiError: ApiError,
    instance: new ApiClient()
  };
})(window);
