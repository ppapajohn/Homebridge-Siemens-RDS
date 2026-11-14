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
| Mode **Auto** | Automatic time program (writes `REei=5`) |
| Mode **Heat** | Manual comfort (writes `CmfBtn=1`) |
| Mode **Off** | Thermostat off (writes `OccMod=Off`) |
| Separate **Away** switch | Away on/off (writes `OccMod=Absent` / `Present`) |

HomeKit's thermostat mode names are fixed by Apple, so Away is a separate switch. Disable it with `"awaySwitch": false`.

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
  "devices": [{ "plantId": "P...", "name": "Living Room" }]
}
```

`devices` is optional. Use it to rename thermostats or hide them (`"exclude": true`). Plant IDs are printed in the log at startup.

## Getting the API key

Siemens does not publish the key. Capture it from the RDS app's traffic to `api.climatixic.com`:
use mitmproxy or Charles and look for the `Ocp-Apim-Subscription-Key` request header. You only need the key;
the plugin logs in with your e-mail and password and renews its own 14-day token.

## Logs

Run Homebridge in debug mode to see the raw values on every poll (room, target, RH, output, OccMod, PrOpModRsn priority).
