'use strict';

const { ClimatixClient, P } = require('./climatix');
const { RdsThermostat } = require('./thermostat');

const PLUGIN_NAME = 'homebridge-siemens-rds';
const PLATFORM_NAME = 'SiemensRDS';

class RdsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();   // UUID -> PlatformAccessory restored from cache
    this.devices = new Map();  // plantId -> RdsThermostat

    const { email, password, apiKey } = this.config;
    if (!email || !password || !apiKey) {
      this.log.warn('Not configured yet: enter the Siemens e-mail, password and API key in the plugin settings.');
      return;
    }

    this.client = new ClimatixClient({ email, password, apiKey, apiBase: this.config.apiBase, log });
    this.pollInterval = Math.min(Math.max(Number(this.config.pollInterval) || 60, 30), 600);

    api.on('didFinishLaunching', () => {
      this.discover().catch((e) => this.log.error('Startup failed: %s', e && e.message ? e.message : e));
    });
    api.on('shutdown', () => this.devices.forEach((d) => d.stop()));
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  async discover(attempt = 1) {
    let plants;
    try {
      plants = await this.client.getPlants();
    } catch (e) {
      const wait = Math.min(attempt * 60, 900);
      this.log.error('Could not reach the Siemens cloud (%s). Retrying in %ds.', e.message, wait);
      // keep cached thermostats alive so HomeKit shows "No Response" instead of stale values
      for (const acc of this.cached.values()) {
        if (acc.context.plantId && !this.devices.has(acc.context.plantId)) {
          this.devices.set(acc.context.plantId, new RdsThermostat(this, acc, acc.context.plantId));
        }
      }
      setTimeout(() => {
        this.discover(attempt + 1).catch((err) => this.log.error('Startup failed: %s', err && err.message ? err.message : err));
      }, wait * 1000);
      return;
    }

    // "devices" entries match a thermostat by plant ID or by its room name in the Siemens app
    const norm = (v) => String(v || '').trim().toLowerCase();
    const entries = (this.config.devices || []).filter((d) => d && (d.match || d.plantId));
    const findOverride = (plantId, room) => entries.find((d) => {
      const key = norm(d.match || d.plantId);
      return key === norm(plantId) || (room && key === norm(room));
    }) || {};
    const keep = new Set();

    for (const plant of plants) {
      // read the thermostat once up front, so it gets its final name before HomeKit sees it
      let points = null;
      try {
        points = await this.client.getPoints(plant.id);
      } catch (e) {
        this.log.warn('Could not read thermostat %s yet (%s)', plant.id, e.message);
      }
      const roomRaw = points && points.value(P.DESCRIPTION);
      const room = typeof roomRaw === 'string' && roomRaw.trim() && roomRaw !== 'Device object' ? roomRaw.trim() : '';

      const ov = findOverride(plant.id, room);
      if (ov.exclude) {
        this.log.info('Hiding thermostat "%s" (plantId %s) as configured', room || plant.id, plant.id);
        continue;
      }
      const uuid = this.api.hap.uuid.generate(plant.id);
      const name = (ov.name && ov.name.trim()) || room || plant.description || `Siemens ${plant.asn || 'RDS'}`;
      keep.add(uuid);
      this.log.info('Thermostat "%s": Siemens room "%s", plantId %s', name, room || '-', plant.id);

      let accessory = this.cached.get(uuid);
      if (!accessory) {
        this.log.info('Adding thermostat "%s" (plantId %s)', name, plant.id);
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.plantId = plant.id;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        this.log.info('Restored thermostat "%s" (plantId %s)', accessory.displayName, plant.id);
      }
      accessory.context.model = plant.asn || 'RDS';
      const existing = this.devices.get(plant.id);
      if (existing) {
        if (existing.name !== name) existing.setName(name);
      } else {
        this.devices.set(plant.id, new RdsThermostat(this, accessory, plant.id, { points, name }));
      }
    }

    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    stale.forEach((a) => {
      const d = this.devices.get(a.context.plantId);
      if (d) { d.stop(); this.devices.delete(a.context.plantId); }
    });
    if (stale.length) {
      this.log.info('Removing %d thermostat(s) that are hidden or no longer on the account', stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
    if (!plants.length) {
      this.log.warn('No RDS thermostats found on this Siemens account.');
    }
  }
}

module.exports = { RdsPlatform, PLATFORM_NAME, PLUGIN_NAME };
