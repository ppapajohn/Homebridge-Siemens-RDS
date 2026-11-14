'use strict';

/*
 * Minimal client for the Siemens Climatix IC cloud API used by the RDS app.
 * Endpoints and semantics ported from the openHAB "siemensrds" binding (EPL-2.0).
 */

const DEFAULT_API = 'https://api.climatixic.com/';
const RDS_MODELS = '[{"asn":"RDS110"},{"asn":"RDS120"},{"asn":"RDS110.R"},{"asn":"RDS120.B"}]';

// Point classes (suffix of the point's hierarchyName on the Climatix server)
const P = {
  DESCRIPTION: "'Description",
  ONLINE: '#Online',
  ROOM_TEMP: "'RTemp",
  ROOM_HUMIDITY: "'RHuRel",
  TARGET_TEMP: "'SpTR",
  OUTPUT_STATE: "'HCSta",      // Null*Neither*Heating*Cooling
  OCC_MODE: "'OccMod",         // Null*Off*Absent*Present
  PR_OP_MOD_RSN: "'PrOpModRsn",
  CMF_BTN: "'CmfBtn",          // write 1 => manual comfort
  ENERGY_LEVEL: "'REei",       // write 5 => back to automatic (green leaf)
};
const POLLED_CLASSES = Object.values(P).filter((c) => c !== P.DESCRIPTION);

class ClimatixError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class ClimatixClient {
  constructor({ email, password, apiKey, apiBase, log }) {
    this.email = email;
    this.password = password;
    this.apiKey = apiKey;
    this.api = (apiBase || DEFAULT_API).replace(/\/?$/, '/');
    this.log = log;
    this.token = null;
    this.tokenExpires = 0;
  }

  async login() {
    const body = `grant_type=password&username=${encodeURIComponent(this.email)}`
      + `&password=${encodeURIComponent(this.password)}&expire_minutes=20160`;
    const res = await fetch(this.api + 'Token', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/plain;charset=UTF-8',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Ocp-Apim-Subscription-Key': this.apiKey,
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new ClimatixError(`login failed: HTTP ${res.status} ${res.statusText}`, res.status);
    }
    const json = await res.json();
    if (!json.access_token) {
      throw new ClimatixError('login failed: no access_token in response');
    }
    this.token = json.access_token;
    const exp = Date.parse(json['.expires']);
    // renew one hour early; if the expiry can't be parsed, assume one day
    this.tokenExpires = (Number.isNaN(exp) ? Date.now() + 86400000 : exp) - 3600000;
    this.log.debug('Climatix login OK, token valid until %s', new Date(this.tokenExpires).toISOString());
  }

  async request(method, path, body, retry = true) {
    if (!this.token || Date.now() > this.tokenExpires) {
      await this.login();
    }
    const res = await fetch(this.api + path, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json;charset=UTF-8',
        'Content-Type': 'application/json;charset=UTF-8',
        'Ocp-Apim-Subscription-Key': this.apiKey,
        'Authorization': `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 && retry) {
      this.token = null; // token revoked or expired early: log in again once
      return this.request(method, path, body, false);
    }
    if (!res.ok) {
      throw new ClimatixError(`${method} ${path.split('?')[0]} failed: HTTP ${res.status} ${res.statusText}`, res.status);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async getPlants() {
    const json = await this.request('GET', 'Plants?filterId=' + encodeURIComponent(RDS_MODELS));
    return (json && json.items) || [];
  }

  /** Full point set of one thermostat (includes metadata such as hierarchyName and enum texts). */
  async getPoints(plantId) {
    const json = await this.request('GET',
      `DataPoints?parentId=${encodeURIComponent(JSON.stringify([plantId]))}&take=100`);
    return new PointSet(json && json.values);
  }

  /** Values only, for the given point ids. */
  async getValues(pointIds) {
    const json = await this.request('GET',
      'DataPoints/Values?filterId=' + encodeURIComponent(JSON.stringify(pointIds)));
    return (json && json.values) || {};
  }

  async setValue(pointId, value) {
    await this.request('PUT', `DataPoints/${pointId}`, { value });
  }
}

/** Holds the point metadata of one thermostat and lets us look points up by class. */
class PointSet {
  constructor(values) {
    if (!values || typeof values !== 'object') {
      throw new ClimatixError('empty data point set');
    }
    this.points = values;
    this.classToId = {};
    for (const [id, p] of Object.entries(values)) {
      this.classToId[PointSet.pointClass(p)] = id;
    }
  }

  static pointClass(p) {
    const h = p.hierarchyName;
    if (h) {
      const i = h.lastIndexOf("'");
      return i >= 0 ? h.substring(i) : h;
    }
    return '#' + (p.memberName || 'undefined');
  }

  id(cls) {
    return this.classToId[cls];
  }

  has(cls) {
    return this.id(cls) !== undefined;
  }

  /** Numeric (or string) value of a point; handles both flat and nested value shapes. */
  value(cls) {
    const p = this.points[this.id(cls)];
    if (!p) return undefined;
    const v = p.value;
    return v !== null && typeof v === 'object' ? v.value : v;
  }

  priority(cls) {
    const p = this.points[this.id(cls)];
    if (!p) return undefined;
    const v = p.value;
    if (v !== null && typeof v === 'object' && v.presentPriority !== undefined) return v.presentPriority;
    return p.presentPriority;
  }

  enumText(cls) {
    const p = this.points[this.id(cls)];
    const n = this.value(cls);
    if (!p || typeof p.descr !== 'string' || !p.descr.includes('*') || typeof n !== 'number') return undefined;
    return p.descr.split('*')[n];
  }

  limits(cls) {
    const p = this.points[this.id(cls)];
    return p && Array.isArray(p.limits) ? p.limits : undefined;
  }

  polledIds() {
    return POLLED_CLASSES.map((c) => this.id(c)).filter(Boolean);
  }

  /** Merge a values-only refresh into the existing set. */
  merge(newValues) {
    for (const [id, nv] of Object.entries(newValues)) {
      const p = this.points[id];
      if (!p || !nv) continue;
      if (p.value !== null && typeof p.value === 'object' && nv.value !== null && typeof nv.value === 'object') {
        p.value = { ...p.value, ...nv.value };
      } else {
        p.value = nv.value;
      }
      if (nv.presentPriority !== undefined) p.presentPriority = nv.presentPriority;
    }
  }
}

module.exports = { ClimatixClient, ClimatixError, PointSet, P };
