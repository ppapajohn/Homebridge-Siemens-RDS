# Homebridge-Siemens-RDS

Homebridge plugin for Siemens RDS110 / RDS110.R / RDS120 smart thermostats. It talks to the Siemens
Climatix IC cloud (`api.climatixic.com`), which is the same backend the Siemens Smart Thermostat RDS app uses.
The API logic is ported from the openHAB `siemensrds` binding (EPL-2.0).

## What HomeKit sees

One Thermostat accessory per RDS on your Siemens account:

| HomeKit | RDS |
|---|---|
| Current temperature | Room temperature (`RTemp`) |
| Humidity | Room relative humidity (`RHuRel`) |
| Target temperature (0.5° steps, 6–35 °C) | Setpoint (`SpTR`) |
| Heating / idle | Output state (`HCSta`) |
| Mode **Auto** | **Auto**: follows the RDS weekly time program (writes `REei=5`) |
| Mode **Heat** | **Manual**: holds the temperature you set and ignores the time program (writes `CmfBtn=1`) |
| Mode **Off** | **Off**: thermostat switched off (writes `OccMod=Off`) |
| Separate **"<name> Away"** switch | **Away**: on/off (writes `OccMod=Absent` / `Present`) |

### Why "Heat" means Manual, and why Away is a switch

Apple's Home app only offers four fixed thermostat modes: Off, Heat, Cool and Auto. A plugin can hide modes
(Cool is hidden here) but cannot add new ones or rename them. So:

- **Heat in the Home app = Manual in the Siemens app.** The label is set by iOS and can't be changed.
- **Away** has no matching HomeKit mode, so it is a separate switch next to each thermostat.
  Turn it off with `"awaySwitch": false`.
- Selecting Heat, Auto or Off clears Away.

Thermostats are named after the room set in the Siemens app (e.g. "Ground Floor"), unless you set a name in `devices`.

The plugin polls every 60 s by default. After any change from HomeKit it polls every 8 s for about 50 s.
If the cloud or the thermostat is unreachable, HomeKit shows "No Response" instead of stale values.

## Config

```json
{
  "platform": "SiemensRDS",
  "name": "Siemens RDS",
  "email": "you@example.com",
  "password": "your Siemens app password",
  "apiKey": "32-character Ocp-Apim-Subscription-Key",
  "pollInterval": 60,
  "devices": [
    { "plantId": "1st Floor", "name": "First floor" },
    { "plantId": "Garage", "exclude": true }
  ]
}
```

### Naming thermostats

By default each thermostat is named after its room in the Siemens app.

To use other names, or to hide a thermostat, add it under **Thermostat names** (`devices`) **before pairing with
HomeKit**. Identify it by its room name as shown in the Siemens app (case-insensitive) or by its plant ID.
At startup the log lists every thermostat:

```
Thermostat "1st Floor": Siemens room "1st Floor", plantId P7fb024f2-...
```

Names are set before the thermostat is published to HomeKit. If you rename after pairing, the Home app usually keeps
its own name. Either rename it in the Home app, or remove the bridge from the Home app and pair it again.

## Getting the API key

Siemens does not publish the key. Capture it from the RDS app's traffic to `api.climatixic.com`:
use mitmproxy or Charles and look for the `Ocp-Apim-Subscription-Key` request header. You only need the key;
the plugin logs in with your e-mail and password and renews its own 14-day token.

## Logs

Run Homebridge in debug mode to see the raw values on every poll (room, target, RH, output, OccMod, PrOpModRsn priority).
