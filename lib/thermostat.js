'use strict';

const { P } = require('./climatix');

const FAST_POLL_SECONDS = 8;   // after a change, poll quickly for a short while
const FAST_POLL_CYCLES = 6;
const DEBOUNCE_MS = 15000;     // ignore cloud values for a characteristic just written from HomeKit

// RDS occupancy mode values (OccMod: Null*Off*Absent*Present)
const OCC_OFF = 1;
const OCC_ABSENT = 2;
const OCC_PRESENT = 3;

const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

class RdsThermostat {
  constructor(platform, accessory, plantId) {
    this.platform = platform;
    this.log = platform.log;
    this.client = platform.client;
    this.accessory = accessory;
    this.plantId = plantId;
    this.name = accessory.displayName;
    this.nameFromConfig = !!platform.nameOverrides[plantId];
    this.points = null;
    this.lastOk = 0;
    this.online = false;
    this.debounce = {};
    this.pending = {};             // optimistic values shown while the cloud catches up
    this.fastCycles = 0;
    this.busy = Promise.resolve();

    const { Service, Characteristic } = platform.api.hap;
    this.Characteristic = Characteristic;
    this.C = Characteristic;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Siemens')
      .setCharacteristic(Characteristic.Model, accessory.context.model || 'RDS')
      .setCharacteristic(Characteristic.SerialNumber, plantId);

    const s = this.service = accessory.getService(Service.Thermostat)
      || accessory.addService(Service.Thermostat, this.name);

    s.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -10, maxValue: 60 })
      .onGet(() => this.read('current', () => this.points.value(P.ROOM_TEMP)));

    s.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: 6, maxValue: 35, minStep: 0.5 })
      .onGet(() => this.read('target', () => this.points.value(P.TARGET_TEMP)))
      .onSet((v) => this.setTarget(v));

    s.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.read('currentMode', () => this.currentMode()));

    s.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
          Characteristic.TargetHeatingCoolingState.AUTO,
        ],
      })
      .onGet(() => this.read('targetMode', () => this.targetMode()))
      .onSet((v) => this.setMode(v));

    s.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .setProps({ validValues: [Characteristic.TemperatureDisplayUnits.CELSIUS] })
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);

    s.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.read('humidity', () => this.points.value(P.ROOM_HUMIDITY)));

    // Separate "Away" switch (HomeKit's thermostat mode names are fixed by Apple)
    const awayName = `${this.name} Away`;
    this.awaySwitch = null;
    if (platform.config.awaySwitch !== false) {
      const a = this.awaySwitch = accessory.getServiceById(Service.Switch, 'away')
        || accessory.addService(Service.Switch, awayName, 'away');
      a.setCharacteristic(Characteristic.Name, awayName);
      if (Characteristic.ConfiguredName) {
        if (!a.testCharacteristic(Characteristic.ConfiguredName)) a.addOptionalCharacteristic(Characteristic.ConfiguredName);
        a.setCharacteristic(Characteristic.ConfiguredName, awayName);
      }
      a.getCharacteristic(Characteristic.On)
        .onGet(() => this.read('away', () => this.points.value(P.OCC_MODE) === OCC_ABSENT))
        .onSet((v) => this.setAway(v));
    } else {
      const old = accessory.getServiceById(Service.Switch, 'away');
      if (old) accessory.removeService(old);
    }

    this.poll();
    this.timer = setInterval(() => this.poll(), this.platform.pollInterval * 1000);
    this.fastTimer = setInterval(() => {
      if (this.fastCycles > 0) {
        this.fastCycles--;
        this.poll();
      }
    }, FAST_POLL_SECONDS * 1000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.fastTimer);
  }

  // ---------- state mapping ----------

  currentMode() {
    const C = this.C.CurrentHeatingCoolingState;
    return this.points.enumText(P.OUTPUT_STATE) === 'Heating' ? C.HEAT : C.OFF;
  }

  targetMode() {
    const C = this.C.TargetHeatingCoolingState;
    const occ = this.points.value(P.OCC_MODE);
    if (occ === OCC_OFF) return C.OFF;                                // thermostat switched off
    if (occ === OCC_ABSENT) return C.AUTO;                            // Away (shown on the Away switch)
    if ((this.points.priority(P.PR_OP_MOD_RSN) ?? 0) > 13) return C.AUTO; // running the time program
    return C.HEAT;                                                    // manual comfort
  }

  // ---------- HomeKit handlers ----------

  read(key, fn) {
    const stale = Date.now() - this.lastOk > this.platform.pollInterval * 5000;
    if (!this.points || !this.online || stale) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const v = (this.debounce[key] || 0) > Date.now() && key in this.pending ? this.pending[key] : fn();
    if (v === undefined || v === null || Number.isNaN(v)) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return typeof v === 'number' ? Math.round(v * 10) / 10 : v;
  }

  async setTarget(value) {
    const t = Math.round(value * 2) / 2;
    this.log.info('[%s] set target temperature -> %s°C', this.name, t);
    await this.write([[P.TARGET_TEMP, t]], { target: t });
  }

  async setMode(value) {
    const C = this.C.TargetHeatingCoolingState;
    const occ = this.points && this.points.value(P.OCC_MODE);
    let steps;
    if (value === C.OFF) {
      this.log.info('[%s] set mode -> Off', this.name);
      steps = [[P.OCC_MODE, OCC_OFF]];
    } else if (value === C.AUTO) {
      this.log.info('[%s] set mode -> Auto (time program)', this.name);
      steps = occ === OCC_PRESENT ? [] : [[P.OCC_MODE, OCC_PRESENT]];
      steps.push([P.ENERGY_LEVEL, 5]);
    } else {
      this.log.info('[%s] set mode -> Manual comfort', this.name);
      steps = occ === OCC_PRESENT ? [] : [[P.OCC_MODE, OCC_PRESENT]];
      steps.push([P.CMF_BTN, 1]);
    }
    await this.write(steps, { targetMode: value, away: false });
  }

  async setAway(on) {
    this.log.info('[%s] set Away -> %s', this.name, on ? 'on' : 'off');
    const C = this.C.TargetHeatingCoolingState;
    await this.write([[P.OCC_MODE, on ? OCC_ABSENT : OCC_PRESENT]], on ? { away: true, targetMode: C.AUTO } : { away: false });
  }

  /** Serialise writes, mark characteristics as debounced, then burst-poll to pick up the result. */
  write(steps, optimistic) {
    const run = async () => {
      if (!this.points) await this.fetchAll();
      for (const [cls, value] of steps) {
        const id = this.points.id(cls);
        if (!id) throw new Error(`data point ${cls} not available on this thermostat`);
        await this.client.setValue(id, value);
      }
      const until = Date.now() + DEBOUNCE_MS;
      for (const [k, v] of Object.entries(optimistic)) {
        this.debounce[k] = until;
        this.pending[k] = v;
      }
      this.fastCycles = FAST_POLL_CYCLES;
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => {});
    return p.catch((e) => {
      this.log.error('[%s] write failed: %s', this.name, e.message);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });
  }

  // ---------- polling ----------

  async fetchAll() {
    this.points = await this.client.getPoints(this.plantId);
    this.applyRoomName();
  }

  /** Use the room name set in the Siemens app, unless a name was given in config. */
  applyRoomName() {
    if (this.nameFromConfig) return;
    const room = this.points.value(P.DESCRIPTION);
    if (typeof room !== 'string' || !room.trim() || room === 'Device object' || room.trim() === this.name) return;
    this.setName(room.trim());
  }

  setName(name) {
    const { Service, Characteristic } = this.platform.api.hap;
    this.log.info('[%s] renaming to "%s" (room name from the Siemens app)', this.name, name);
    this.name = name;
    this.accessory.displayName = name;
    this.accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Name, name);
    const named = [[this.service, name]];
    if (this.awaySwitch) named.push([this.awaySwitch, `${name} Away`]);
    for (const [svc, n] of named) {
      svc.setCharacteristic(Characteristic.Name, n);
      if (Characteristic.ConfiguredName && svc.testCharacteristic(Characteristic.ConfiguredName)) {
        svc.setCharacteristic(Characteristic.ConfiguredName, n);
      }
    }
    if (Characteristic.ConfiguredName && !this.service.testCharacteristic(Characteristic.ConfiguredName)) {
      this.service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      this.service.setCharacteristic(Characteristic.ConfiguredName, name);
    }
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  poll() {
    const run = async () => {
      try {
        if (!this.points) {
          await this.fetchAll();
        } else {
          try {
            this.points.merge(await this.client.getValues(this.points.polledIds()));
          } catch (e) {
            this.log.debug('[%s] value refresh failed (%s); reloading full point set', this.name, e.message);
            await this.fetchAll();
          }
        }
        const wasOnline = this.online;
        this.online = this.points.enumText(P.ONLINE) !== 'Offline';
        if (!this.online) {
          if (wasOnline || !this.lastOk) this.log.warn('[%s] Siemens cloud reports the thermostat offline', this.name);
          return;
        }
        if (!wasOnline) this.log.info('[%s] online', this.name);
        this.lastOk = Date.now();
        this.push();
      } catch (e) {
        this.log.warn('[%s] poll failed: %s', this.name, e.message);
      }
    };
    this.busy = this.busy.then(run, run);
    return this.busy;
  }

  push() {
    const C = this.C;
    const now = Date.now();
    const pts = this.points;
    const upd = (key, ch, v) => {
      if (v === undefined || v === null || Number.isNaN(v)) return;
      if ((this.debounce[key] || 0) > now) return;
      this.service.updateCharacteristic(ch, typeof v === 'number' ? Math.round(v * 10) / 10 : v);
    };
    upd('current', C.CurrentTemperature, pts.value(P.ROOM_TEMP));
    upd('target', C.TargetTemperature, pts.value(P.TARGET_TEMP));
    upd('humidity', C.CurrentRelativeHumidity, pts.value(P.ROOM_HUMIDITY));
    upd('currentMode', C.CurrentHeatingCoolingState, this.currentMode());
    upd('targetMode', C.TargetHeatingCoolingState, this.targetMode());
    if (this.awaySwitch && (this.debounce.away || 0) <= now) {
      this.awaySwitch.updateCharacteristic(C.On, pts.value(P.OCC_MODE) === OCC_ABSENT);
    }

    this.log.debug('[%s] room %s°C, target %s°C, RH %s%%, output %s, OccMod %s, PrOpModRsn prio %s',
      this.name, r1(pts.value(P.ROOM_TEMP)), r1(pts.value(P.TARGET_TEMP)), r1(pts.value(P.ROOM_HUMIDITY)),
      pts.enumText(P.OUTPUT_STATE), pts.enumText(P.OCC_MODE), pts.priority(P.PR_OP_MOD_RSN));
  }
}

module.exports = { RdsThermostat };
