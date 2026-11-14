'use strict';

const { ClimatixClient } = require('./climatix');
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
      this.log.error('email, password and apiKey are all required; plugin disabled until they are set.');
      return;
    }

    this.client = new ClimatixClient({ email, password, apiKey, apiBase: this.config.apiBase, log });
    this.pollInterval = Math.min(Math.max(Number(this.config.pollInterval) || 60, 30), 600);

    api.on('didFinishLaunching', () => this.discover());
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
      setTimeout(() => this.discover(attempt + 1), wait * 1000);
      return;
    }

    const overrides = new Map((this.config.devices || []).map((d) => [d.plantId, d]));
    const keep = new Set();

    for (const plant of plants) {
      const ov = overrides.get(plant.id) || {};
      if (ov.exclude) {
        this.log.info('Skipping excluded thermostat %s', plant.id);
        continue;
      }
      const uuid = this.api.hap.uuid.generate(plant.id);
      const name = ov.name || plant.description || `Siemens ${plant.asn || 'RDS'}`;
      keep.add(uuid);

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
      if (!this.devices.has(plant.id)) {
        this.devices.set(plant.id, new RdsThermostat(this, accessory, plant.id));
      }
    }

    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    stale.forEach((a) => {
      const d = this.devices.get(a.context.plantId);
      if (d) { d.stop(); this.devices.delete(a.context.plantId); }
    });
    if (stale.length) {
      this.log.info('Removing %d thermostat(s) no longer on the account', stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
    if (!plants.length) {
      this.log.warn('No RDS thermostats found on this Siemens account.');
    }
  }
}

module.exports = { RdsPlatform, PLATFORM_NAME, PLUGIN_NAME };
