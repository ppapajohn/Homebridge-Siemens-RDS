'use strict';

/*
 * Server side of the plugin settings page. Runs only while the settings dialog is open.
 * Lists the thermostats on the Siemens account so the page can show one row per thermostat.
 */

const { ClimatixClient, P } = require('../lib/climatix');

(async () => {
  // @homebridge/plugin-ui-utils is ESM-only
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/thermostats', (payload) => this.listThermostats(payload));
      this.ready();
    }

    async listThermostats({ email, password, apiKey, apiBase } = {}) {
      if (!email || !password || !apiKey) {
        throw new RequestError('Enter e-mail, password and API key first.', { status: 400 });
      }
      const log = { debug() {}, info() {}, warn() {}, error() {} };
      const client = new ClimatixClient({ email, password, apiKey, apiBase, log });
      let plants;
      try {
        plants = await client.getPlants();
      } catch (e) {
        const hint = e.status === 400 || e.status === 401
          ? 'Check the e-mail, password and API key.'
          : 'Could not reach the Siemens cloud.';
        throw new RequestError(`${hint} (${e.message})`, { status: e.status || 500 });
      }

      const result = [];
      for (const plant of plants) {
        const row = { plantId: plant.id, model: plant.asn || 'RDS', online: plant.isOnline !== false, room: '', temperature: null };
        try {
          const points = await client.getPoints(plant.id);
          const room = points.value(P.DESCRIPTION);
          if (typeof room === 'string' && room.trim() && room !== 'Device object') row.room = room.trim();
          const t = points.value(P.ROOM_TEMP);
          if (typeof t === 'number') row.temperature = Math.round(t * 10) / 10;
        } catch (e) {
          row.error = e.message;
        }
        result.push(row);
      }
      return result;
    }
  }

  return new UiServer();
})();
