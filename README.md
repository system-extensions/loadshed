# Service Pauser

GNOME Shell extension for pausing selected background maintenance services from Quick Settings.

The extension delegates privileged work to `/usr/local/bin/service-pauser-helper`.
The helper reads and writes root-owned units in `/etc/service-pauser/units.json` and uses
`systemctl freeze`/`systemctl thaw` for services. Timers configured next to a service
are stopped while paused and only restarted if the helper stopped them. While the
Quick Settings button is paused, refreshes enforce that state again for configured
services that start later.

## Install

```bash
git clone https://github.com/shell-extensions/service-pauser
cd service-pauser
./install.sh
```

`install.sh` compiles the schemas, packs the extension bundle, installs it with
`gnome-extensions install -f`, and sets up the privileged helper, configuration, and
sudoers rule in one step.

Log out and back in, then enable:

```bash
gnome-extensions enable service-pauser@yurij.de
```

## Configure Services

Open the extension preferences in GNOME Extensions to add, remove, save, reload,
or restore the built-in maintenance catalog. The default catalog is installed only
when `/etc/service-pauser/units.json` does not already exist; updates keep your
existing configuration.

Run `./install.sh` after updating the extension so the helper and sudoers rules
include the configuration and enforce commands.

Advanced users can still edit `/etc/service-pauser/units.json` as root. Built-in
catalog entries are marked optional, so services not installed on the machine are
ignored silently. Custom entries are not optional by default, so mistakes remain
visible in the menu. Entry format:

```json
[
  {
    "id": "aide",
    "label": "AIDE daily check",
    "service": "dailyaidecheck.service",
    "timer": "dailyaidecheck.timer",
    "optional": true
  }
]
```

## GSettings switches

Not everything worth pausing is a systemd unit. The [Folder Size](https://github.com/shell-extensions/foldersize)
extension, for example, scans folder sizes in Nautilus and is controlled by a
plain GSettings boolean (`auto-scan`) instead. For cases like this, Service
Pauser can also toggle arbitrary GSettings booleans together with the pause
button — no root or helper involved, since these are user-session settings.

This is configured in Preferences under "GSettings switches", separately from
the systemd service list. Each entry has a schema id, a key, and the value the
key should hold while paused; entries are validated (schema installed, key
exists and is boolean) before being used, and unavailable ones are skipped
silently rather than breaking the extension. A Folder Size preset ships
out of the box and can be restored with one click if removed.

Most extensions compile their schema only inside their own extension
directory rather than installing it system-wide, so it won't be found by
plain schema lookup. If that happens ("Schema not installed" in
Preferences even though the extension is installed), set the entry's
"Extension UUID" field (e.g. `foldersize@yurij.de`) — Service Pauser then
also looks in that extension's own `schemas/` directory, the same way GNOME
Shell resolves an extension's own settings.

If an entry's target extension also has its own Quick Settings toggle (like
Folder Size's "Scan on/off"), that toggle becomes redundant once Service
Pauser manages it — set as `own_toggle_key`, it gets hidden automatically
while managed here and reappears once you disable the switch or Service
Pauser itself.

## Manual Recovery

```bash
sudo /usr/local/bin/service-pauser-helper status
sudo /usr/local/bin/service-pauser-helper resume
sudo /usr/local/bin/service-pauser-helper config-get
```
