# Changelog

## 1.0.1 (2026-11-14)

First public release.

- Siemens RDS110 / RDS110.R / RDS120 smart thermostats in HomeKit, through the Siemens Climatix IC cloud
- Room temperature, humidity, target temperature (0.5° steps) and heating state
- Modes: Auto (time program), Heat (= Manual in the Siemens app), Off
- Separate Away switch per thermostat (optional)
- Settings page in the Homebridge UI that lists every thermostat on the account, so you can rename or hide each one before pairing with HomeKit
- Thermostats are named after their room in the Siemens app by default
- "No Response" in HomeKit when the cloud or the thermostat is unreachable, instead of stale values
- Login token renewed automatically
