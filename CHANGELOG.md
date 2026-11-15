# Changelog

## 1.0.3 (2026-11-15)

- Verified by Homebridge
- Rename accessories with `updateDisplayName()`, so Homebridge's copy of the name stays in step (review feedback)
- Donate link (PayPal) on the plugin tile in the Homebridge UI. Donations strictly for bikes and cycling equipment! 🤩🚴‍♂️💙

## 1.0.2 (2026-11-14)

- Declare HAP support (`supports-hap` keyword) for the Homebridge plugin directory
- Config schema: `required` fields listed at object level, as JSON Schema expects

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
