/* =============================================================================
 * Sync layer
 *
 * Translates between the UI's in-memory model (first/last, `tz`, `value` in
 * dollars, `lastCalled` as epoch ms) and the API's (firstName/lastName,
 * `timezone`, `valueCents`, `lastCalledAt` as ISO). Keeping the translation
 * here means the rendering code above never has to know the API exists.
 *
 * Writes are optimistic: the UI mutates its own arrays and re-renders instantly
 * (so dialling never waits on a network round-trip), and this layer mirrors
 * those changes to the server in a debounced batch. Failures are collected and
 * surfaced rather than silently dropped.
 * ========================================================================== */
(function (global) {
  'use strict';

  var api = global.DialflowApi.instance;
  var ApiError = global.DialflowApi.ApiError;

  var FLUSH_DELAY_MS = 700;

  var state = {
    online: false,
    created: {},   // uiId -> true
    dirty: {},     // uiId -> true
    removed: [],   // server ids
    notes: [],     // { leadId, text }
    calls: [],     // { leadId, callId, payload }
    failed: 0,
    onStatus: null
  };

  function status(kind, message) {
    if (typeof state.onStatus === 'function') state.onStatus(kind, message);
  }

  /* ------------------------------------------------------- model mapping */

  function fromApiLead(a) {
    return {
      id: a.id,
      first: a.firstName,
      last: a.lastName,
      name: a.name,
      company: a.company || '—',
      title: a.title || '—',
      email: a.email || '',
      phone: a.phone,
      raw: a.phoneRaw || a.phone,
      tz: a.timezone || 'PT',
      stage: a.stage,
      value: typeof a.value === 'number' ? a.value : (a.valueCents || 0) / 100,
      source: a.source || '—',
      score: a.score,
      lastCalled: a.lastCalledAt ? Date.parse(a.lastCalledAt) : null,
      notes: []
    };
  }

  function toApiLead(l) {
    return {
      firstName: l.first,
      lastName: l.last,
      phone: l.phone || l.raw,
      email: l.email || null,
      company: l.company && l.company !== '—' ? l.company : null,
      title: l.title && l.title !== '—' ? l.title : null,
      timezone: l.tz || null,
      source: l.source && l.source !== '—' ? l.source : null,
      value: Number(l.value) || 0,
      stage: l.stage,
      score: typeof l.score === 'number' ? Math.round(l.score) : undefined
    };
  }

  function fromApiCall(c) {
    return {
      id: c.id,
      leadId: c.leadId,
      leadName: (c.lead && c.lead.name) || '',
      company: (c.lead && c.lead.company) || '',
      phone: (c.lead && c.lead.phone) || '',
      mode: c.mode,
      disposition: c.disposition || '',
      duration: c.durationSec || 0,
      time: c.startedAt ? Date.parse(c.startedAt) : Date.now(),
      note: c.note || ''
    };
  }

  /* --------------------------------------------------------- connection */

  function connect(apiKey) {
    if (apiKey) api.setKey(apiKey);
    return api.connect(1500).then(function (ok) {
      state.online = ok;
      if (ok) {
        // Reachability alone is not authentication. A wrong key must be
        // reported as a wrong key, not silently downgraded to offline mode.
        return api.getSettings().then(function () {
          state.online = true;
          status('online', 'API connected');
          return true;
        }, function (err) {
          state.online = err && err.status === 401 ? true : false;
          status(err && err.status === 401 ? 'auth' : 'offline',
                 err && err.status === 401 ? 'API reachable — key rejected' : 'API unreachable');
          return false;
        });
      }
      status('offline', 'API unreachable — using local cache');
      return false;
    });
  }

  /* ------------------------------------------------------------ loading */

  function load() {
    return Promise.all([api.listLeads(), api.listCalls({})]).then(function (res) {
      var leadRows = (res[0] && res[0].data) || [];
      var leads = leadRows.map(fromApiLead);

      var callRows = (res[1] && res[1].data) || [];
      var calls = callRows.map(fromApiCall);

      return { leads: leads, calls: calls };
    });
  }

  /* ------------------------------------------------------------- writing */

  function markCreated(lead) {
    state.created[lead.id] = true;
    schedule();
  }

  function markDirty(lead) {
    // A lead created this session is still being created; one PATCH before the
    // POST lands would be a guaranteed 404.
    if (state.created[lead.id]) { schedule(); return; }
    state.dirty[lead.id] = true;
    schedule();
  }

  function markRemoved(serverId) {
    if (state.created[serverId]) { delete state.created[serverId]; schedule(); return; }
    if (state.removed.indexOf(serverId) === -1) state.removed.push(serverId);
    schedule();
  }

  function queueNote(leadId, text) {
    if (leadId && !String(leadId).startsWith('id_')) state.notes.push({ leadId: leadId, text: text });
    schedule();
  }

  function queueCall(payload) {
    state.calls.push(payload);
    schedule();
  }

  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!state.online) return Promise.resolve({ skipped: true });

    var createdIds = Object.keys(state.created);
    var dirtyIds = Object.keys(state.dirty);
    var removed = state.removed.slice();
    var notes = state.notes.slice();
    var calls = state.calls.slice();

    // Clear the queues first: if a write fails the item is re-queued, which is
    // simpler and safer than mutating shared state mid-flight.
    state.created = {};
    state.dirty = {};
    state.removed = [];
    state.notes = [];
    state.calls = [];

    var work = [];

    removed.forEach(function (id) {
      work.push(api.deleteLead(id).catch(function (err) {
        if (err.status !== 404) state.removed.push(id);
        state.failed++;
      }));
    });

    createdIds.forEach(function (id) {
      var lead = findLead(id);
      if (!lead) return;
      work.push(api.createLead(toApiLead(lead)).then(function (created) {
        // Swap the UI's temp id for the server's so subsequent updates hit the
        // right row instead of 404ing.
        var oldId = id;
        lead.id = created.id;
        rekeyLocal(oldId, created.id);
        delete state.dirty[oldId];
      }).catch(function () {
        state.created[id] = true;   // retry on the next flush
        state.failed++;
      }));
    });

    dirtyIds.forEach(function (id) {
      var lead = findLead(id);
      if (!lead || String(id).startsWith('id_')) return;
      work.push(api.updateLead(id, toApiLead(lead)).catch(function () {
        state.dirty[id] = true;
        state.failed++;
      }));
    });

    notes.forEach(function (n) {
      work.push(api.addNote(n.leadId, n.text).catch(function () {
        state.notes.push(n);
        state.failed++;
      }));
    });

    calls.forEach(function (c) {
      work.push(
        api.dial(c.leadId, c.mode)
          .then(function (call) {
            // The server is the source of truth for call state; pull the
            // authoritative record back rather than trusting local timings.
            return api.request('GET', '/api/calls/' + call.id);
          })
          .then(function (call) {
            if (!call) return null;
            return api.completeCall(call.id, c.payload).then(function (done) {
              return api.request('GET', '/api/calls/' + call.id).then(function (fresh) {
                if (c.onDone) c.onDone(fresh || done);
                return fresh;
              });
            });
          })
          .catch(function () {
            state.calls.push(c);
            state.failed++;
          })
      );
    });

    if (!work.length) return Promise.resolve({ skipped: true });

    status('sync', 'Syncing…');
    return Promise.all(work).then(function () {
      status(state.failed ? 'error' : 'synced',
             state.failed ? state.failed + ' change(s) failed to sync' : 'Synced');
      if (state.failed) state.failed = 0;
      return { ok: true };
    });
  }

  /* --------------------------------------------- local access for rekeying */

  var hooks = { findLead: null, rekey: null };

  function findLead(id) {
    if (typeof hooks.findLead === 'function') return hooks.findLead(id);
    return null;
  }

  /** Rewrites an id in place across the app's arrays. Set by the app at boot. */
  function rekeyLocal(oldId, newId) {
    if (typeof hooks.rekey === 'function') hooks.rekey(oldId, newId);
  }

  global.DialflowSync = {
    state: state,
    connect: connect,
    load: load,
    fromApiLead: fromApiLead,
    toApiLead: toApiLead,
    fromApiCall: fromApiCall,
    markCreated: markCreated,
    markDirty: markDirty,
    markRemoved: markRemoved,
    queueNote: queueNote,
    queueCall: queueCall,
    flush: flush,
    setHooks: function (h) { hooks = h; },
    onStatus: function (fn) { state.onStatus = fn; },
    api: api,
    ApiError: ApiError
  };
})(window);
